import { config } from './config.js';
import { createServer } from './server.js';

const server = createServer();

server.on('error', (error) => {
  console.error(JSON.stringify({
    event: 'server.listen_failed',
    code: error.code,
    message: error.message,
    host: config.host,
    port: config.port
  }));
  process.exitCode = 1;
});

server.listen(config.port, config.host, () => {
  console.log(JSON.stringify({
    event: 'server.listening',
    host: config.host,
    port: config.port,
    model: config.llm.model,
    llmConfigured: Boolean(config.llm.apiKey)
  }));
});
