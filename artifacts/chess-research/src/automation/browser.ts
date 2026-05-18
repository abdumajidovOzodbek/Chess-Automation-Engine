import { chromium, Browser, BrowserContext, Page, type BrowserContextOptions } from "playwright";
import { createLogger } from "../logger/index.ts";
import type { BrowserConfig } from "../types.ts";

const logger = createLogger("browser");

export class BrowserManager {
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private pages: Map<string, Page> = new Map();
  private config: Required<BrowserConfig>;

  constructor(config: BrowserConfig = {}) {
    this.config = {
      headless: config.headless ?? false,
      slowMo: config.slowMo ?? 0,
      timeout: config.timeout ?? 30_000,
      userAgent: config.userAgent ?? "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36",
      viewport: config.viewport ?? { width: 1280, height: 800 },
      recordVideo: config.recordVideo ?? false,
      recordVideoDir: config.recordVideoDir ?? "./recordings",
      storageStatePath: config.storageStatePath ?? "",
    };
  }

  async launch(): Promise<void> {
    logger.info({ headless: this.config.headless, slowMo: this.config.slowMo }, "Launching browser");

    this.browser = await chromium.launch({
      headless: this.config.headless,
      slowMo: this.config.slowMo,
      args: [
        "--no-sandbox",
        "--disable-blink-features=AutomationControlled",
        "--disable-dev-shm-usage",
        "--disable-web-security",
      ],
    });

    const contextOptions: BrowserContextOptions = {
      userAgent: this.config.userAgent,
      viewport: this.config.viewport,
    };

    if (this.config.recordVideo) {
      contextOptions.recordVideo = { dir: this.config.recordVideoDir };
    }

    if (this.config.storageStatePath) {
      try {
        const { existsSync } = await import("fs");
        if (existsSync(this.config.storageStatePath)) {
          contextOptions.storageState = this.config.storageStatePath;
          logger.info({ path: this.config.storageStatePath }, "Loaded session storage state");
        }
      } catch {
        logger.warn("Could not load storage state");
      }
    }

    this.context = await this.browser.newContext(contextOptions);
    this.context.setDefaultTimeout(this.config.timeout);
    this.context.setDefaultNavigationTimeout(this.config.timeout);

    this.context.on("page", (page) => {
      logger.debug({ url: page.url() }, "New page opened");
    });

    logger.info("Browser launched successfully");
  }

  async newPage(id: string = "main"): Promise<Page> {
    if (!this.context) throw new Error("Browser not launched — call launch() first");

    const page = await this.context.newPage();

    page.on("console", (msg) => {
      if (msg.type() === "error") {
        logger.debug({ msg: msg.text() }, "Browser console error");
      }
    });

    page.on("pageerror", (err) => {
      logger.warn({ error: err.message }, "Page error");
    });

    this.pages.set(id, page);
    logger.debug({ id }, "New page created");
    return page;
  }

  getPage(id: string = "main"): Page {
    const page = this.pages.get(id);
    if (!page) throw new Error(`No page with id "${id}" — call newPage() first`);
    return page;
  }

  async saveStorageState(path: string): Promise<void> {
    if (!this.context) throw new Error("No active context");
    await this.context.storageState({ path });
    logger.info({ path }, "Storage state saved");
  }

  async screenshot(pageId: string = "main", path?: string): Promise<Buffer> {
    const page = this.getPage(pageId);
    const buffer = await page.screenshot({ path, fullPage: true });
    logger.debug({ path }, "Screenshot captured");
    return buffer;
  }

  async closePage(id: string): Promise<void> {
    const page = this.pages.get(id);
    if (page) {
      await page.close();
      this.pages.delete(id);
      logger.debug({ id }, "Page closed");
    }
  }

  async close(): Promise<void> {
    if (this.context) {
      await this.context.close();
      this.context = null;
    }
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
    }
    this.pages.clear();
    logger.info("Browser closed");
  }

  isLaunched(): boolean {
    return this.browser !== null && this.browser.isConnected();
  }
}
