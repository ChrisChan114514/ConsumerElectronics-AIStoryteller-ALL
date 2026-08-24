import { iotConfig } from './config.js';
import { createIoTService } from './mqttService.js';

const service = await createIoTService();

try {
  await service.start();
  console.log(JSON.stringify({
    event: 'iot.mqtt_listening',
    host: iotConfig.host,
    port: iotConfig.mqttPort,
    webService: iotConfig.webServiceUrl,
    publicAudioBaseUrl: iotConfig.publicAudioBaseUrl
  }));
} catch (error) {
  console.error(JSON.stringify({ event: 'iot.listen_failed', code: error.code, message: error.message }));
  process.exit(1);
}

const shutdown = async () => {
  await service.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
