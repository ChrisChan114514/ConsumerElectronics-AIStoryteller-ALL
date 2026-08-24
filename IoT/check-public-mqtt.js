import mqtt from 'mqtt';
import { iotConfig } from './config.js';

const host = process.env.IOT_CHECK_HOST || '120.26.111.75';
const port = Number(process.env.IOT_CHECK_PORT) || iotConfig.mqttPort;
const deviceId = process.env.IOT_CHECK_DEVICE_ID || `SIM-PC${Date.now()}`;
const topicBase = `story/v1/devices/${deviceId}`;
const client = mqtt.connect(`mqtt://${host}:${port}`, {
  clientId: deviceId,
  username: iotConfig.mqttUsername,
  password: iotConfig.mqttPassword,
  protocolVersion: 4,
  clean: true,
  reconnectPeriod: 0,
  connectTimeout: 8000
});

const timeout = setTimeout(() => finish(new Error('MQTT test timed out.')), 12_000);
let finished = false;
let connected = false;

function finish(error) {
  if (finished) return;
  finished = true;
  clearTimeout(timeout);
  if (error) {
    console.error(`MQTT_CHECK_FAILED ${error.message}`);
    process.exitCode = 1;
    client.end(true);
  } else {
    client.end(false, {}, () => console.log('DISCONNECTED_OK'));
  }
}

client.on('connect', () => {
  connected = true;
  console.log(`CONNECTED host=${host} port=${port} client_id=${deviceId}`);
  client.subscribe(`${topicBase}/events`, { qos: 1 }, (error, grants) => {
    if (error) return finish(error);
    console.log(`SUBSCRIBED topic=${grants[0].topic} qos=${grants[0].qos}`);
    client.publish(`${topicBase}/status`, JSON.stringify({
      device_id: deviceId,
      state: 'pc_test',
      detail: 'public_mqtt_check',
      uptime_ms: 0
    }), { qos: 1 }, (publishError) => {
      if (publishError) return finish(publishError);
      console.log(`PUBLISHED_QOS1 topic=${topicBase}/status`);
      finish();
    });
  });
});

client.on('error', finish);
client.on('close', () => {
  if (!connected) finish(new Error('Connection closed before MQTT CONNACK; check broker credentials and device ACL.'));
});
