import { Aedes } from 'aedes';
import net from 'node:net';
import { iotConfig } from './config.js';
import { StoryOrchestrator } from './orchestrator.js';
import { StoryServiceClient } from './storyClient.js';
import { IoTRuntimeStatus } from './runtimeStatus.js';

const deviceIdPattern = /^(?:ESP32-[A-Fa-f0-9]{12}|SIM-[A-Za-z0-9_-]{1,40})$/;
const topicPattern = /^story\/v1\/devices\/([^/]+)\/(request|events|status)$/;

function topicFor(deviceId, leaf) {
  return `story/v1/devices/${deviceId}/${leaf}`;
}

function publishBroker(broker, topic, payload, options = {}) {
  return new Promise((resolve, reject) => {
    broker.publish({
      cmd: 'publish',
      topic,
      payload: Buffer.from(JSON.stringify(payload)),
      qos: options.qos ?? 1,
      retain: options.retain ?? false
    }, (error) => error ? reject(error) : resolve());
  });
}

function registerSubscription(broker, topic, handler) {
  return new Promise((resolve, reject) => {
    broker.subscribe(topic, handler, (error) => error ? reject(error) : resolve());
  });
}

export async function createIoTService(options = {}) {
  const settings = { ...iotConfig, ...options };
  const broker = await Aedes.createBroker({ drainTimeout: 30_000 });
  const storyClient = options.storyClient || new StoryServiceClient({ baseUrl: settings.webServiceUrl });
  const orchestrator = options.orchestrator || new StoryOrchestrator({
    storyClient,
    audioDirectory: settings.audioDirectory,
    publicAudioBaseUrl: settings.publicAudioBaseUrl
  });
  const runtimeStatus = options.runtimeStatus || new IoTRuntimeStatus({ statusPath: settings.statusPath });
  const devices = new Map();

  broker.authenticate = (client, username, password, callback) => {
    const valid = deviceIdPattern.test(client?.id || '') &&
      username?.toString() === settings.mqttUsername &&
      password?.toString() === settings.mqttPassword;
    const error = valid ? null : new Error('Invalid IoT device credentials or client ID.');
    if (error) error.returnCode = 4;
    if (!valid) runtimeStatus.authRejected(client?.id || 'unknown');
    callback(error, valid);
  };

  broker.authorizePublish = (client, packet, callback) => {
    if (!client) return callback(null);
    const match = topicPattern.exec(packet.topic);
    const valid = match && match[1] === client.id && ['request', 'status'].includes(match[2]);
    callback(valid ? null : new Error('Device may only publish its own request and status topics.'));
  };

  broker.authorizeSubscribe = (client, subscription, callback) => {
    const match = topicPattern.exec(subscription.topic);
    const valid = match && match[1] === client.id && match[2] === 'events';
    callback(null, valid ? subscription : null);
  };

  broker.on('clientReady', (client) => {
    devices.set(client.id, { device_id: client.id, online: true, connected_at: new Date().toISOString() });
    console.log(JSON.stringify({ event: 'iot.device_connected', deviceId: client.id }));
    runtimeStatus.connected(client.id, client.conn?.remoteAddress || '');
  });
  broker.on('clientDisconnect', (client) => {
    const previous = devices.get(client.id) || { device_id: client.id };
    devices.set(client.id, { ...previous, online: false, disconnected_at: new Date().toISOString() });
    console.log(JSON.stringify({ event: 'iot.device_disconnected', deviceId: client.id }));
    runtimeStatus.disconnected(client.id);
  });
  broker.on('clientError', (client, error) => {
    console.error(JSON.stringify({ event: 'iot.client_error', deviceId: client?.id, message: error.message }));
  });

  await registerSubscription(broker, 'story/v1/devices/+/request', (packet, done) => {
    const match = topicPattern.exec(packet.topic);
    let payload;
    try {
      if (packet.payload.length > 4096) throw new Error('Request payload exceeds 4096 bytes.');
      payload = JSON.parse(packet.payload.toString('utf8'));
    } catch (error) {
      done();
      if (match) {
        void publishBroker(broker, topicFor(match[1], 'events'), {
          type: 'story.error', request_id: '', code: 'INVALID_JSON', message: error.message
        }).catch(console.error);
      }
      return;
    }
    done();
    const deviceId = match[1];
    console.log(JSON.stringify({
      event: 'iot.story_requested', deviceId,
      requestId: payload.request_id, cards: payload.card_ids
    }));
    runtimeStatus.storyRequested(deviceId, payload);
    void orchestrator.run(deviceId, payload,
      (event) => {
        runtimeStatus.storyEvent(deviceId, event);
        return publishBroker(broker, topicFor(deviceId, 'events'), event);
      })
      .catch((error) => console.error(JSON.stringify({
        event: 'iot.orchestration_failed', deviceId, message: error.message
      })));
  });

  await registerSubscription(broker, 'story/v1/devices/+/status', (packet, done) => {
    const match = topicPattern.exec(packet.topic);
    try {
      const payload = JSON.parse(packet.payload.toString('utf8'));
      const previous = devices.get(match[1]) || { device_id: match[1], online: true };
      devices.set(match[1], { ...previous, ...payload, last_seen_at: new Date().toISOString() });
      runtimeStatus.statusReceived(match[1], payload);
    } catch (error) {
      console.error(JSON.stringify({ event: 'iot.invalid_status', deviceId: match?.[1], message: error.message }));
    }
    done();
  });

  const server = net.createServer(broker.handle);
  return {
    broker,
    server,
    devices,
    runtimeStatus,
    async start(port = settings.mqttPort, host = settings.host) {
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => {
          server.off('error', reject);
          resolve();
        });
      });
      await runtimeStatus.start(host, server.address().port);
      return server.address();
    },
    async close() {
      const serverClosed = server.listening
        ? new Promise((resolve) => server.close(resolve))
        : Promise.resolve();
      await new Promise((resolve) => broker.close(resolve));
      await serverClosed;
      await runtimeStatus.close();
    }
  };
}

export { topicFor };
