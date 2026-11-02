import { readFileSync } from 'node:fs';
import { type Browser, expect, type Page } from '@playwright/test';
import { buildZip, type ZipEntryInput } from '../support/zip-builder.ts';

export interface DevState {
  adminOrigin: string;
  publicOrigin: string;
  adminName: string;
  password: string;
}

export function devState(): DevState {
  return JSON.parse(readFileSync('test-results/state/e2e-state.json', 'utf8'));
}

export async function fillLogin(page: Page, username: string, password: string): Promise<void> {
  await page.locator('#login-name').fill(username);
  await page.locator('#login-password').fill(password);
  await page.locator('#login-button').click();
}

export async function openAdmin(
  browser: Browser,
  username: string,
  password: string,
): Promise<Page> {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(devState().adminOrigin);
  await fillLogin(page, username, password);
  await expect(page.locator('#who')).not.toBeEmpty();
  return page;
}

export async function addUser(adminPage: Page, name: string): Promise<string> {
  await adminPage.locator('#user-name').fill(name);
  await adminPage.getByRole('button', { name: '追加する' }).click();
  const row = adminPage.locator(`[data-user="${name}"]`);
  const password = (await row.locator('.password').textContent()) ?? '';
  expect(password).toMatch(/^[A-Za-z0-9_-]{43}$/);
  return password;
}

export async function publishZip(
  page: Page,
  name: string,
  entries: ZipEntryInput[],
): Promise<void> {
  await page.locator('#page-name').fill(name);
  await page.locator('#page-zip').setInputFiles({
    name: `${name}.zip`,
    mimeType: 'application/zip',
    buffer: buildZip(entries),
  });
  await page.getByRole('button', { name: '公開する' }).click();
}
