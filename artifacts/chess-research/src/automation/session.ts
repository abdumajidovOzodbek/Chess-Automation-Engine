import type { Page } from "playwright";
import { createLogger } from "../logger/index.ts";
import type { SessionConfig } from "../types.ts";
import { CF_IS_LOGGED_IN_SCRIPT } from "../platforms/chessfriends.ts";

const logger = createLogger("session");

export type SessionStatus = "idle" | "authenticating" | "active" | "expired" | "failed";

export class SessionManager {
  private status: SessionStatus = "idle";
  private config: SessionConfig;
  private sessionStartedAt: number | null = null;
  private lastActivityAt: number | null = null;
  private recoveryAttempts = 0;

  constructor(config: SessionConfig) {
    this.config = {
      headless: true,
      slowMo: 0,
      timeout: 30_000,
      loginSelector: 'a[href*="login"], a[href*="signin"], button:has-text("Log in"), button:has-text("Sign in")',
      usernameSelector: 'input[name="username"], input[name="email"], input[type="email"], #username, #email',
      passwordSelector: 'input[name="password"], input[type="password"], #password',
      submitSelector: 'button[type="submit"], input[type="submit"], button:has-text("Log in"), button:has-text("Sign in")',
      ...config,
    };
  }

  async authenticate(page: Page): Promise<boolean> {
    this.status = "authenticating";
    logger.info({ url: this.config.url }, "Starting authentication");

    try {
      await page.goto(this.config.url, { waitUntil: "domcontentloaded" });
      await page.waitForLoadState("networkidle").catch(() => {});

      if (await this.isAlreadyLoggedIn(page)) {
        logger.info("Already authenticated — skipping login");
        this.status = "active";
        this.sessionStartedAt = Date.now();
        return true;
      }

      if (!this.config.username || !this.config.password) {
        logger.warn("No credentials provided — proceeding as guest");
        this.status = "active";
        this.sessionStartedAt = Date.now();
        return true;
      }

      await this.performLogin(page);
      this.status = "active";
      this.sessionStartedAt = Date.now();
      this.lastActivityAt = Date.now();
      logger.info("Authentication successful");
      return true;
    } catch (err) {
      this.status = "failed";
      logger.error({ err }, "Authentication failed");
      return false;
    }
  }

  private async performLogin(page: Page): Promise<void> {
    const loginSelector = this.config.loginSelector!;
    const loginBtn = page.locator(loginSelector).first();

    if (await loginBtn.isVisible().catch(() => false)) {
      logger.debug("Clicking login button to open form");
      await loginBtn.click();
      await page.waitForTimeout(500);
    }

    const usernameField = page.locator(this.config.usernameSelector!).first();
    await usernameField.waitFor({ state: "visible", timeout: 10_000 });
    await usernameField.fill("");
    await usernameField.type(this.config.username!, { delay: 40 + Math.random() * 30 });

    await page.waitForTimeout(200 + Math.random() * 300);

    const passwordField = page.locator(this.config.passwordSelector!).first();
    await passwordField.waitFor({ state: "visible" });
    await passwordField.fill("");
    await passwordField.type(this.config.password!, { delay: 40 + Math.random() * 30 });

    await page.waitForTimeout(300 + Math.random() * 400);

    const submitBtn = page.locator(this.config.submitSelector!).first();
    await submitBtn.click();

    // For SPA sites (like chessfriends) there may be no navigation — wait briefly
    await Promise.race([
      page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 8_000 }).catch(() => {}),
      page.waitForTimeout(4_000),
    ]);
    await page.waitForLoadState("networkidle").catch(() => {});

    if (!(await this.isAlreadyLoggedIn(page))) {
      const errorMsg = await this.detectLoginError(page);
      throw new Error(`Login failed${errorMsg ? `: ${errorMsg}` : ""}`);
    }
  }

  private async isAlreadyLoggedIn(page: Page): Promise<boolean> {
    // Platform-specific JS check: works for chessfriends.com (CF.Store.getGameUser)
    try {
      const jsResult = await page.evaluate(
        (script: string) => (new Function("return " + script))() as boolean,
        CF_IS_LOGGED_IN_SCRIPT
      );
      if (jsResult) return true;
    } catch { /* not on chessfriends or CF not loaded yet */ }

    const logoutIndicators = [
      'a[href*="logout"]',
      'button:has-text("Log out")',
      'button:has-text("Sign out")',
      '[data-testid="user-menu"]',
      '[data-testid="user-avatar"]',
      '.user-menu',
      '.avatar',
      '[aria-label*="profile"]',
    ];

    for (const sel of logoutIndicators) {
      if (await page.locator(sel).first().isVisible().catch(() => false)) {
        return true;
      }
    }
    return false;
  }

  private async detectLoginError(page: Page): Promise<string> {
    const errorSelectors = [
      ".error-message",
      "[class*='error']",
      "[class*='alert']",
      "[role='alert']",
      ".notification-danger",
    ];
    for (const sel of errorSelectors) {
      const el = page.locator(sel).first();
      if (await el.isVisible().catch(() => false)) {
        return (await el.textContent())?.trim() ?? "";
      }
    }
    return "";
  }

  async recover(page: Page): Promise<boolean> {
    this.recoveryAttempts++;
    logger.warn({ attempt: this.recoveryAttempts }, "Attempting session recovery");

    if (this.recoveryAttempts > 5) {
      logger.error("Max recovery attempts exceeded");
      this.status = "failed";
      return false;
    }

    try {
      const currentUrl = page.url();
      await page.reload({ waitUntil: "domcontentloaded" }).catch(() => {});
      await page.waitForLoadState("networkidle").catch(() => {});

      if (!currentUrl.includes(this.config.url.split("/")[2] ?? "")) {
        await page.goto(this.config.url, { waitUntil: "domcontentloaded" });
      }

      if (await this.isAlreadyLoggedIn(page)) {
        this.status = "active";
        this.recoveryAttempts = 0;
        logger.info("Session recovered successfully");
        return true;
      }

      return await this.authenticate(page);
    } catch (err) {
      logger.error({ err }, "Session recovery failed");
      this.status = "expired";
      return false;
    }
  }

  touchActivity(): void {
    this.lastActivityAt = Date.now();
  }

  getStatus(): SessionStatus { return this.status; }
  getSessionAge(): number | null {
    return this.sessionStartedAt ? Date.now() - this.sessionStartedAt : null;
  }
  getLastActivity(): number | null { return this.lastActivityAt; }
  isActive(): boolean { return this.status === "active"; }
}
