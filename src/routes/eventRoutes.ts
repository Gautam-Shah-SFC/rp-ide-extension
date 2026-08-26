import { Provider } from "../class/Provider";
import { CaptureController } from "../controllers/captureController";
import { logger } from "../utils/logger";

export async function wireProviders(providers: Provider[], captureController: CaptureController): Promise<void> {
  for (const provider of providers) {
    const available = await provider.isAvailable();
    if (!available) {
      logger.info(`${provider.displayName}: not available on this machine, skipping`);
      continue;
    }
    await provider.start((event) => captureController.handleEvent(event));
    logger.info(`${provider.displayName}: capture started`);
  }
}

export async function stopProviders(providers: Provider[]): Promise<void> {
  for (const provider of providers) {
    await provider.stop();
  }
}
