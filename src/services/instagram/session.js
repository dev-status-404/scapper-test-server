// ═══════════════════════════════════════════════════════════════════════════
// Instagram Session Management (Login, Cookies, Authentication State)
// ═══════════════════════════════════════════════════════════════════════════

import fs from "fs";
import path from "path";
import {
  humanDelay,
  pageLoadDelay,
  humanType,
} from "../utils/instagram-helpers.js";

/**
 * Save cookies to file
 * @param {Page} page - Puppeteer page object
 * @param {string} filepath - Path to save cookies
 */
export const saveCookies = async (page, filepath) => {
  const cookies = await page.cookies();

  // Ensure directory exists
  const dir = path.dirname(filepath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
    console.log(`[Instagram] Created directory: ${dir}`);
  }

  fs.writeFileSync(filepath, JSON.stringify(cookies, null, 2));
  console.log(`[Instagram] Cookies saved to ${filepath}`);
};

/**
 * Load cookies from file
 * @param {Page} page - Puppeteer page object
 * @param {string} filepath - Path to load cookies from
 * @returns {boolean} True if cookies were loaded successfully
 */
export const loadCookies = async (page, filepath) => {
  if (fs.existsSync(filepath)) {
    const cookies = JSON.parse(fs.readFileSync(filepath, "utf-8"));
    await page.setCookie(...cookies);
    console.log(`[Instagram] Cookies loaded from ${filepath}`);
    return true;
  }
  return false;
};

/**
 * Check if currently logged into Instagram
 * @param {Page} page - Puppeteer page object
 * @returns {boolean} True if logged in
 */
export const isLoggedIn = async (page) => {
  try {
    // Wait a bit for page to settle
    await humanDelay(1500, 2500);

    console.log("[Instagram] Running login detection checks...");

    // PRIORITY 1: Positive check - Look for elements that only appear when logged in
    const loggedInIndicator = await page.evaluate(() => {
      // Check for nav bar elements (home, search, etc.)
      const nav = document.querySelector("nav");
      if (nav) {
        // Look for home link or user menu or svg icons (indicating logged-in nav)
        const hasHomeLink = nav.querySelector('a[href="/"]');
        const hasSvg = nav.querySelector("svg");
        const hasProfileLink = nav.textContent
          .toLowerCase()
          .includes("profile");

        if ((hasHomeLink && hasSvg) || hasProfileLink) {
          console.log("[Instagram Check] Found logged-in navigation elements");
          return true;
        }
      }

      // Check for search bar or create post elements
      const hasSearchOrCreate =
        document.querySelector('input[placeholder*="Search"]') ||
        document.querySelector('[aria-label*="New post"]') ||
        document.querySelector('[aria-label*="Create"]');
      if (hasSearchOrCreate) {
        console.log("[Instagram Check] Found search/create elements");
        return true;
      }

      return false;
    });

    if (loggedInIndicator) {
      console.log(
        "[Instagram] ✓ Detected logged-in state (positive indicators)",
      );
      return true;
    }

    // PRIORITY 2: Check for login page URL
    const currentUrl = page.url();
    if (currentUrl.includes("/accounts/login")) {
      console.log("[Instagram] ✗ On login page - not logged in");
      return false;
    }

    // PRIORITY 3: Check for "Log in" dialog/modal (appears on profile pages when not logged in)
    const loginDialog = await page.evaluate(() => {
      const dialogs = document.querySelectorAll('div[role="dialog"]');
      for (const dialog of dialogs) {
        const text = dialog.textContent;
        if (text.includes("Log in") || text.includes("Sign up for Instagram")) {
          console.log("[Instagram Check] Found login dialog");
          return true;
        }
      }
      return false;
    });

    if (loginDialog) {
      console.log("[Instagram] ✗ Detected login dialog - not logged in");
      return false;
    }

    // PRIORITY 4: Check for login form inputs (last resort)
    const emailInput = await page.$('input[name="email"]');
    const usernameInput = await page.$('input[name="username"]');
    const passwordInput = await page.$(
      'input[name="pass"], input[name="password"]',
    );

    if ((emailInput || usernameInput) && passwordInput) {
      console.log("[Instagram] ✗ Detected login form - not logged in");
      return false;
    }

    // If we reach here and found no negative indicators, assume logged in
    console.log("[Instagram] ✓ No login indicators found - assuming logged in");
    return true;
  } catch (error) {
    console.log("[Instagram] Error checking login status:", error.message);
    return false;
  }
};

/**
 * Dismiss Instagram prompts/dialogs (Save Login Info, Notifications, etc.)
 * @param {Page} page - Puppeteer page object
 * @param {number} maxAttempts - Maximum attempts to dismiss prompts
 */
export const dismissPrompts = async (page, maxAttempts = 3) => {
  for (let i = 0; i < maxAttempts; i++) {
    await humanDelay(1000, 2000);

    const dismissed = await page.evaluate(() => {
      // Find "Not Now" buttons
      const elements = Array.from(
        document.querySelectorAll('button, div[role="button"]'),
      );
      const notNowButton = elements.find((el) => {
        const text = el.textContent.trim().toLowerCase();
        return text === "not now";
      });

      if (notNowButton) {
        const parentText = notNowButton.closest("div")?.textContent || "";
        console.log(
          `[Instagram Check] Found "Not Now" button in context: ${parentText.substring(0, 50)}...`,
        );
        notNowButton.click();
        return true;
      }

      return false;
    });

    if (dismissed) {
      console.log(`[Instagram] Dismissed prompt (attempt ${i + 1})`);
      await humanDelay(1000, 2000);
    } else {
      // No more prompts found
      console.log(`[Instagram] No more prompts to dismiss (attempt ${i + 1})`);
      break;
    }
  }
};

/**
 * Login to Instagram with Puppeteer automation
 * @param {Page} page - Puppeteer page object
 * @returns {boolean} True if login successful
 */
export const loginToInstagram = async (page) => {
  const username = process.env.INSTAGRAM_USERNAME;
  const password = process.env.INSTAGRAM_PASSWORD;
  const usernameSelector =
    process.env.INSTAGRAM_USERNAME_SELECTOR || 'input[name="username"]';
  const passwordSelector =
    process.env.INSTAGRAM_PASSWORD_SELECTOR || 'input[name="password"]';

  if (!username || !password) {
    throw new Error(
      "Instagram credentials not configured in environment variables",
    );
  }

  console.log("[Instagram] Navigating to login page...");
  await page.goto("https://www.instagram.com/accounts/login/", {
    waitUntil: "networkidle2",
    timeout: 30000,
  });

  await pageLoadDelay();

  // Give extra time for account selection screen to fully render
  await humanDelay(1500, 2500);

  // Check for account selection screen and click "Use another profile"
  console.log("[Instagram] Checking for account selection screen...");

  // Try to wait for the "Use another profile" button (up to 5 seconds)
  let useAnotherProfileClicked = false;
  try {
    await page.waitForSelector(
      '[aria-label="Use another profile"][role="button"]',
      {
        timeout: 5000,
        visible: true,
      },
    );
    console.log(
      '[Instagram] "Use another profile" button detected, clicking...',
    );

    useAnotherProfileClicked = await page.evaluate(() => {
      const useAnotherBtn = document.querySelector(
        '[aria-label="Use another profile"][role="button"]',
      );
      if (useAnotherBtn) {
        console.log('[Instagram] Clicking "Use another profile" button...');
        useAnotherBtn.click();
        return true;
      }
      return false;
    });
  } catch (error) {
    console.log(
      '[Instagram] "Use another profile" button not found within timeout, checking manually...',
    );

    // Fallback: manual search
    useAnotherProfileClicked = await page.evaluate(() => {
      const allButtons = Array.from(
        document.querySelectorAll('[role="button"]'),
      );
      console.log(
        `[Instagram] Manually checking ${allButtons.length} buttons...`,
      );

      for (const btn of allButtons) {
        const btnText = btn.textContent.trim();
        const ariaLabel = btn.getAttribute("aria-label");

        if (
          btnText.includes("Use another profile") ||
          btnText.includes("use another profile") ||
          ariaLabel?.includes("Use another profile")
        ) {
          console.log(`[Instagram] Found match, clicking...`);
          btn.click();
          return true;
        }
      }
      return false;
    });
  }

  if (useAnotherProfileClicked) {
    console.log(
      "[Instagram] Clicked 'Use another profile', waiting for login form...",
    );
    await humanDelay(2000, 3000);
  } else {
    console.log(
      "[Instagram] 'Use another profile' button not found, checking if login form is already visible...",
    );
    await humanDelay(1000, 1500);
  }

  // Check if username and password fields exist
  console.log("[Instagram] Checking for login form fields...");
  const fieldsExist = await page.evaluate(
    (usernameSelector, passwordSelector) => {
      const usernameField = document.querySelector(usernameSelector);
      const passwordField = document.querySelector(passwordSelector);
      return {
        usernameExists: !!usernameField,
        passwordExists: !!passwordField,
        usernameVisible: usernameField && usernameField.offsetParent !== null,
        passwordVisible: passwordField && passwordField.offsetParent !== null,
      };
    },
    usernameSelector,
    passwordSelector,
  );

  console.log(`[Instagram] Login fields status:`, fieldsExist);

  // If neither field exists, throw error
  if (!fieldsExist.usernameExists && !fieldsExist.passwordExists) {
    throw new Error(
      "Login form not found - no username or password fields detected",
    );
  }

  // Wait for fields to be visible if they exist but aren't visible yet
  if (
    (fieldsExist.usernameExists && !fieldsExist.usernameVisible) ||
    (fieldsExist.passwordExists && !fieldsExist.passwordVisible)
  ) {
    console.log("[Instagram] Waiting for login fields to become visible...");
    await humanDelay(1000, 2000);
  }

  // Type username only if field exists (some modals only show password for saved accounts)
  if (fieldsExist.usernameExists && fieldsExist.usernameVisible) {
    console.log("[Instagram] Typing username...");
    await humanType(page, usernameSelector, username, 120);
    await humanDelay(500, 1000);
  } else {
    console.log(
      "[Instagram] Skipping username (field not present - using saved account)",
    );
  }

  // Type password (should always be present)
  if (fieldsExist.passwordExists && fieldsExist.passwordVisible) {
    console.log("[Instagram] Typing password...");
    await humanType(page, passwordSelector, password, 100);
    await humanDelay(800, 1500);
  } else {
    throw new Error("Password field not visible or not found");
  }

  console.log("[Instagram] Clicking login button...");
  // Find and click login button by text content (more reliable than classes)
  const loginClicked = await page.evaluate(() => {
    const buttons = Array.from(
      document.querySelectorAll('button, div[role="button"]'),
    );
    const loginButton = buttons.find(
      (btn) => btn.textContent.trim().toLowerCase() === "log in",
    );
    if (loginButton) {
      loginButton.click();
      return true;
    }
    return false;
  });

  if (!loginClicked) {
    throw new Error("Login button not found");
  }

  // Wait for navigation after login
  await page.waitForNavigation({ waitUntil: "networkidle2", timeout: 30000 });
  await pageLoadDelay();

  // Dismiss any prompts that appear after login (Save Info, Notifications, etc.)
  console.log("[Instagram] Checking for post-login prompts...");
  await dismissPrompts(page, 3);

  console.log("[Instagram] Login successful!");
  return true;
};
