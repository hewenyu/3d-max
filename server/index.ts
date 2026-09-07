import { createApp } from './app.ts';
import { getConfig } from './config.ts';

const config = getConfig();
const service = createApp(config);
const server = service.app.listen(config.port, '127.0.0.1', () => {
  console.log(`Whiteframe API: ${config.apiUrl}`);
  console.log(`MCP endpoint: ${config.apiUrl}/mcp`);
});
const reviewServer = service.reviewApp.listen(service.review.port, service.review.host, () => {
  console.log(`Whiteframe review: ${service.review.url}`);
});
const onError = (error: Error) => {
  console.error(error.message);
  process.exitCode = 1;
  void shutdown();
};
server.on('error', onError);
reviewServer.on('error', onError);
let closing = false;
async function shutdown() {
  if (closing) return;
  closing = true;
  server.close();
  server.closeAllConnections();
  reviewServer.close();
  reviewServer.closeAllConnections();
  await service.close();
}
process.on('SIGINT', () => {
  void shutdown();
});
process.on('SIGTERM', () => {
  void shutdown();
});
