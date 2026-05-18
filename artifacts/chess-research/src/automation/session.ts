import type { Page } from "playwright";
import { createLogger } from "../logger/index.ts";
import type { SessionConfig } from "../types.ts";
import { CF_IS_LOGGED_IN_SCRIPT, waitForCFReady } from "../platforms/chessfriends.ts";

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
      loginSelector: '.x-button:has-text("Sign In")',
      usernameSelector: 'input[name="nickname"]',
      passwordSelector: 'input[type="password"]',
      submitSelector: 'input[type="submit"]',
      ...config,
    };
  }

  async authenticate(page: Page): Promise<boolean> {
    this.status = "authenticating";
    logger.info({ url: this.config.url }, "Starting authentication");

    try {
      await page.goto(this.config.url, { waitUntil: "domcontentloaded" });

      // Wait for the Sencha Touch / CF SPA to fully initialise before interacting
      await waitForCFReady(page, 45_000);

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
    // ── Step 1: Open the login dialog ─────────────────────────────────────────
    const loginSelector = this.config.loginSelector!;
    const loginBtn = page.locator(loginSelector).first();

    const loginBtnVisible = await loginBtn.isVisible({ timeout: 8_000 }).catch(() => false);
    if (loginBtnVisible) {
      logger.debug({ loginSelector }, "Clicking login button to open form");
      await loginBtn.click();
      // Wait for the login form inputs to appear
      await page.waitForSelector('input[name="nickname"]', { timeout: 10_000 }).catch(() => {});
      await page.waitForTimeout(500);
    } else {
      logger.warn({ loginSelector }, "Login button not found — trying to fill form directly");
    }

    // ── Step 2: Fill username ──────────────────────────────────────────────────
    const usernameField = page.locator(this.config.usernameSelector!).first();
    await usernameField.waitFor({ state: "visible", timeout: 10_000 });
    // Use fill() for reliability — type() triggers per-keystroke Sencha Touch events
    // that can corrupt form state on chessfriends.com
    await usernameField.click();
    await usernameField.fill(this.config.username!);
    logger.debug({ value: this.config.username }, "Username filled");

    await page.waitForTimeout(300);

    // ── Step 3: Fill password ──────────────────────────────────────────────────
    const passwordField = page.locator(this.config.passwordSelector!).first();
    await passwordField.waitFor({ state: "visible", timeout: 5_000 });
    await passwordField.click();
    await passwordField.fill(this.config.password!);
    logger.debug("Password filled");

    await page.waitForTimeout(400);

    // ── Step 4: Submit the form ────────────────────────────────────────────────
    // Primary: press Enter on the password field — most reliable for Sencha Touch forms
    // Fallback A: click hidden input[type="submit"] with force
    // Fallback B: click the "Sign In" fill button inside the dialog
    let submitted = false;

    // Primary: Enter key on password field (confirmed working in live tests)
    try {
      await passwordField.press("Enter");
      submitted = true;
      logger.debug("Submitted via Enter key on password field");
    } catch (e) {
      logger.debug({ err: e }, "Enter key failed — trying force click");
    }

    if (!submitted) {
      try {
        const submitEl = page.locator(this.config.submitSelector!).first();
        await submitEl.click({ force: true, timeout: 3_000 });
        submitted = true;
        logger.debug({ selector: this.config.submitSelector }, "Submitted via submitSelector (force)");
      } catch {
        logger.debug("submitSelector force click failed — trying dialog Sign In button");
      }
    }

    if (!submitted) {
      // Last resort: find the "Sign In" fill button that appeared inside the dialog
      const dialogSignIn = page.locator('.x-button.x-button-fill').filter({ hasText: /^Sign In$/ }).last();
      try {
        await dialogSignIn.click({ timeout: 3_000 });
        submitted = true;
        logger.debug("Submitted via dialog Sign In button");
      } catch (e) {
        logger.warn({ err: e }, "All submit strategies failed");
      }
    }

    // ── Step 5: Wait for login to complete ────────────────────────────────────
    // chessfriends.com may show an x-msgbox modal ("You have been logged out from another device")
    // after a successful login — we must dismiss it before getGameUser() becomes non-null.
    // Poll in a loop: dismiss any modal, check if logged in, repeat until success or timeout.
    logger.debug("Waiting for CF login to complete...");

    const loginDeadline = Date.now() + 35_000;
    let loggedIn = false;

    while (Date.now() < loginDeadline) {
      // 1. Dismiss any visible x-msgbox by clicking its OK/confirm button
      const msgbox = page.locator(".x-msgbox").first();
      const msgboxVisible = await msgbox.isVisible().catch(() => false);
      if (msgboxVisible) {
        const msgText = (await msgbox.textContent().catch(() => "")) ?? "";
        logger.debug({ msgText }, "Detected x-msgbox — looking for OK button to dismiss");
        // Sencha Touch msgbox: button is .x-button inside the box
        const okBtn = msgbox.locator(".x-button").last();
        await okBtn.click().catch(() => {});
        logger.info({ msgText }, "Dismissed x-msgbox");
        await page.waitForTimeout(800);
      }

      // 2. Check if login is now complete
      const isLoggedIn = await page.evaluate(() => {
        try {
          const cf = (window as unknown as Record<string, unknown>)["CF"] as Record<string, unknown> | undefined;
          if (!cf) return false;
          const store = cf["Store"] as Record<string, unknown> | undefined;
          if (!store) return false;
          const getUser = store["getGameUser"] as (() => unknown) | undefined;
          return typeof getUser === "function" && !!getUser();
        } catch { return false; }
      }).catch(() => false);

      if (isLoggedIn) { loggedIn = true; break; }

      // 3. Short pause before next poll
      await page.waitForTimeout(500);
    }

    if (!loggedIn) {
      // Final settle + last chance check
      await page.waitForTimeout(1_500);
      loggedIn = await this.isAlreadyLoggedIn(page);
    }

    if (!loggedIn) {
      const errorMsg = await this.detectLoginError(page);
      throw new Error(`Login failed${errorMsg ? `: ${errorMsg}` : " — CF.Store.getGameUser() still null after submit"}`);
    }

    logger.info("CF login verified — user authenticated");
  }

  private async isAlreadyLoggedIn(page: Page): Promise<boolean> {
    // Platform-specific JS check: works for chessfriends.com (CF.Store.getGameUser)
    // Use inline function to avoid serialization issues in bundled code.
    try {
      const jsResult = await page.evaluate(() => {
        try {
          const cf = (window as unknown as Record<string, unknown>)["CF"] as Record<string, unknown> | undefined;
          if (!cf) return false;
          const store = cf["Store"] as Record<string, unknown> | undefined;
          if (!store) return false;
          const getUser = store["getGameUser"] as (() => unknown) | undefined;
          return typeof getUser === "function" && !!getUser();
        } catch { return false; }
      });
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
      ".x-msgbox",
      ".cf-error",
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

      // Wait for SPA to reinitialise after reload
      await waitForCFReady(page, 30_000);

      if (!currentUrl.includes(this.config.url.split("/")[2] ?? "")) {
        await page.goto(this.config.url, { waitUntil: "domcontentloaded" });
        await waitForCFReady(page, 30_000);
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
