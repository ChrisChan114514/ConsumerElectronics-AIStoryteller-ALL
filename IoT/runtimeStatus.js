import fs from 'node:fs/promises';
import path from 'node:path';
import { iotConfig } from './config.js';

const maximumRecentActions = 100;
const staleAfterMs = 15_000;

function emptySnapshot() {
  return {
    service: 'story-machine-iot',
    online: false,
    host: iotConfig.host,
    port: iotConfig.mqttPort,
    started_at: null,
    updated_at: null,
    connected_devices: 0,
    counters: {
      connections: 0,
      disconnections: 0,
      auth_rejected: 0,
      story_requests: 0,
      status_messages: 0,
      stories_ready: 0,
      story_errors: 0
    },
    devices: [],
    recent_actions: []
  };
}

function isHealthProbe(deviceId) {
  return typeof deviceId === 'string' && deviceId.startsWith('SIM-HEALTH');
}

export class IoTRuntimeStatus {
  constructor({ statusPath = iotConfig.statusPath, now = () => Date.now() } = {}) {
    this.statusPath = statusPath;
    this.now = now;
    this.startedAt = new Date(this.now()).toISOString();
    this.online = false;
    this.host = iotConfig.host;
    this.port = iotConfig.mqttPort;
    this.counters = emptySnapshot().counters;
    this.devices = new Map();
    this.actions = [];
    this.writeQueue = Promise.resolve();
    this.persistTimer = null;
    this.heartbeatTimer = null;
  }

  action(type, deviceId = '', detail = '') {
    if (isHealthProbe(deviceId)) return;
    this.actions.unshift({
      at: new Date(this.now()).toISOString(),
      type,
      device_id: deviceId,
      detail: String(detail || '').slice(0, 240)
    });
    this.actions.length = Math.min(this.actions.length, maximumRecentActions);
  }

  snapshot() {
    const devices = [...this.devices.values()]
      .filter((device) => !isHealthProbe(device.device_id))
      .sort((left, right) => String(right.last_seen_at || '').localeCompare(String(left.last_seen_at || '')));
    return {
      service: 'story-machine-iot',
      online: this.online,
      host: this.host,
      port: this.port,
      started_at: this.startedAt,
      updated_at: new Date(this.now()).toISOString(),
      connected_devices: devices.filter((device) => device.online).length,
      counters: { ...this.counters },
      devices,
      recent_actions: [...this.actions]
    };
  }

  persist() {
    const snapshot = this.snapshot();
    this.writeQueue = this.writeQueue.then(async () => {
      await fs.mkdir(path.dirname(this.statusPath), { recursive: true });
      const temporary = `${this.statusPath}.${process.pid}.tmp`;
      await fs.writeFile(temporary, JSON.stringify(snapshot, null, 2));
      await fs.rename(temporary, this.statusPath);
    }).catch((error) => console.error(JSON.stringify({
      event: 'iot.status_write_failed', message: error.message
    })));
    return this.writeQueue;
  }

  schedulePersist() {
    if (this.persistTimer) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      void this.persist();
    }, 200);
    this.persistTimer.unref?.();
  }

  start(host, port) {
    this.host = host;
    this.port = port;
    this.online = true;
    this.action('broker.started', '', `${host}:${port}`);
    this.heartbeatTimer = setInterval(() => void this.persist(), 5000);
    this.heartbeatTimer.unref?.();
    return this.persist();
  }

  connected(deviceId, remoteAddress = '') {
    if (isHealthProbe(deviceId)) return;
    const now = new Date(this.now()).toISOString();
    const previous = this.devices.get(deviceId) || { device_id: deviceId };
    this.devices.set(deviceId, {
      ...previous,
      device_id: deviceId,
      online: true,
      remote_address: remoteAddress,
      connected_at: now,
      last_seen_at: now
    });
    this.counters.connections += 1;
    this.action('device.connected', deviceId, remoteAddress);
    this.schedulePersist();
  }

  disconnected(deviceId) {
    if (isHealthProbe(deviceId)) return;
    const now = new Date(this.now()).toISOString();
    const previous = this.devices.get(deviceId) || { device_id: deviceId };
    this.devices.set(deviceId, { ...previous, online: false, disconnected_at: now, last_seen_at: now });
    this.counters.disconnections += 1;
    this.action('device.disconnected', deviceId);
    this.schedulePersist();
  }

  authRejected(deviceId) {
    if (isHealthProbe(deviceId)) return;
    this.counters.auth_rejected += 1;
    this.action('device.auth_rejected', deviceId);
    this.schedulePersist();
  }

  storyRequested(deviceId, payload) {
    this.counters.story_requests += 1;
    const previous = this.devices.get(deviceId) || { device_id: deviceId, online: true };
    this.devices.set(deviceId, {
      ...previous,
      last_request_id: payload.request_id,
      last_card_ids: payload.card_ids,
      last_seen_at: new Date(this.now()).toISOString()
    });
    this.action('story.requested', deviceId, `${payload.request_id || ''} ${(payload.card_ids || []).join(',')}`);
    this.schedulePersist();
  }

  statusReceived(deviceId, payload) {
    if (isHealthProbe(deviceId)) return;
    this.counters.status_messages += 1;
    const previous = this.devices.get(deviceId) || { device_id: deviceId, online: true };
    this.devices.set(deviceId, {
      ...previous,
      ...payload,
      device_id: deviceId,
      online: true,
      last_seen_at: new Date(this.now()).toISOString()
    });
    if (previous.state !== payload.state) this.action('device.status', deviceId, payload.state || 'unknown');
    this.schedulePersist();
  }

  storyEvent(deviceId, event) {
    if (event.type === 'story.ready') this.counters.stories_ready += 1;
    if (event.type === 'story.error') this.counters.story_errors += 1;
    const detail = [event.request_id, event.story_id, event.audio_path, event.code, event.message]
      .filter(Boolean)
      .join(' ');
    this.action(event.type, deviceId, detail);
    this.schedulePersist();
  }

  async close() {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    if (this.persistTimer) clearTimeout(this.persistTimer);
    this.online = false;
    for (const [deviceId, device] of this.devices) {
      this.devices.set(deviceId, { ...device, online: false });
    }
    this.action('broker.stopped');
    await this.persist();
  }
}

export async function readIoTRuntimeStatus(statusPath = iotConfig.statusPath, now = Date.now()) {
  const resolvedStatusPath = statusPath || iotConfig.statusPath;
  try {
    const snapshot = JSON.parse(await fs.readFile(resolvedStatusPath, 'utf8'));
    const updatedAt = Date.parse(snapshot.updated_at);
    const fresh = Number.isFinite(updatedAt) && now - updatedAt <= staleAfterMs;
    return {
      ...emptySnapshot(),
      ...snapshot,
      online: Boolean(snapshot.online && fresh),
      stale: !fresh,
      status_age_ms: Number.isFinite(updatedAt) ? Math.max(0, now - updatedAt) : null
    };
  } catch (error) {
    if (error.code === 'ENOENT' || error instanceof SyntaxError) {
      return { ...emptySnapshot(), stale: true, status_age_ms: null };
    }
    throw error;
  }
}
