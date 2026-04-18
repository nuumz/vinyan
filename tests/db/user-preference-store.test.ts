import { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  UserPreferenceStore,
  detectAppCategory,
  extractSpecificApp,
  getAppsInCategory,
  isGoalCategoryLevel,
} from '../../src/db/user-preference-store.ts';

describe('detectAppCategory', () => {
  test('maps specific app names to categories', () => {
    expect(detectAppCategory('gmail')).toBe('mail');
    expect(detectAppCategory('outlook')).toBe('mail');
    expect(detectAppCategory('chrome')).toBe('browser');
    expect(detectAppCategory('spotify')).toBe('music');
    expect(detectAppCategory('slack')).toBe('chat');
    expect(detectAppCategory('vscode')).toBe('editor');
  });

  test('maps category keywords', () => {
    expect(detectAppCategory('mail')).toBe('mail');
    expect(detectAppCategory('email')).toBe('mail');
    expect(detectAppCategory('อีเมล')).toBe('mail');
    expect(detectAppCategory('เมล')).toBe('mail');
    expect(detectAppCategory('เพลง')).toBe('music');
  });

  test('detects app within a goal string', () => {
    expect(detectAppCategory('เปิด gmail ให้หน่อย')).toBe('mail');
    expect(detectAppCategory('open spotify')).toBe('music');
    expect(detectAppCategory('แอพ mail')).toBe('mail');
  });

  test('returns undefined for unknown apps', () => {
    expect(detectAppCategory('something random')).toBeUndefined();
    expect(detectAppCategory('ทำอาหาร')).toBeUndefined();
  });

  test('is case-insensitive', () => {
    expect(detectAppCategory('Gmail')).toBe('mail');
    expect(detectAppCategory('CHROME')).toBe('browser');
    expect(detectAppCategory('Outlook')).toBe('mail');
  });
});

describe('extractSpecificApp', () => {
  test('extracts specific app from goal', () => {
    expect(extractSpecificApp('เปิด gmail')).toBe('gmail');
    expect(extractSpecificApp('open outlook')).toBe('outlook');
    expect(extractSpecificApp('เปิด chrome ให้หน่อย')).toBe('chrome');
  });

  test('returns undefined for category-only mentions', () => {
    expect(extractSpecificApp('แอพ mail')).toBeUndefined();
    expect(extractSpecificApp('open email')).toBeUndefined();
  });

  test('returns undefined when no app detected', () => {
    expect(extractSpecificApp('do something random')).toBeUndefined();
  });
});

describe('isGoalCategoryLevel', () => {
  test('returns true for category-only goals', () => {
    expect(isGoalCategoryLevel('แอพ mail')).toBe(true);
    expect(isGoalCategoryLevel('open email')).toBe(true);
    expect(isGoalCategoryLevel('เปิดอีเมล')).toBe(true);
    expect(isGoalCategoryLevel('เปิดเพลง')).toBe(true);
  });

  test('returns false for specific app goals', () => {
    expect(isGoalCategoryLevel('เปิด Gmail')).toBe(false);
    expect(isGoalCategoryLevel('open Outlook')).toBe(false);
    expect(isGoalCategoryLevel('open spotify')).toBe(false);
  });

  test('returns false for unrecognized goals', () => {
    expect(isGoalCategoryLevel('do something random')).toBe(false);
  });
});

describe('getAppsInCategory', () => {
  test('returns known apps for mail category', () => {
    const apps = getAppsInCategory('mail');
    expect(apps).toContain('gmail');
    expect(apps).toContain('outlook');
    expect(apps).toContain('thunderbird');
    // Should NOT include category keywords like 'mail' itself
    expect(apps).not.toContain('mail');
    expect(apps).not.toContain('email');
  });

  test('returns known apps for browser category', () => {
    const apps = getAppsInCategory('browser');
    expect(apps).toContain('chrome');
    expect(apps).toContain('firefox');
    expect(apps).toContain('safari');
  });

  test('returns empty for unknown category', () => {
    expect(getAppsInCategory('unknown')).toEqual([]);
  });
});

describe('UserPreferenceStore', () => {
  let db: Database;
  let store: UserPreferenceStore;

  beforeEach(() => {
    db = new Database(':memory:');
    store = new UserPreferenceStore(db);
  });

  afterEach(() => {
    db.close();
  });

  test('starts with no preferences', () => {
    expect(store.getAllPreferences()).toEqual([]);
    expect(store.getPreference('mail')).toBeUndefined();
  });

  test('records a new preference in probation', () => {
    store.recordUsage('mail', 'gmail', 'open https://mail.google.com');

    const pref = store.getPreference('mail');
    expect(pref).toBeDefined();
    expect(pref!.preferredApp).toBe('gmail');
    expect(pref!.resolvedCommand).toBe('open https://mail.google.com');
    expect(pref!.usageCount).toBe(1);
    expect(pref!.status).toBe('probation');
  });

  test('promotes to active after 2 uses', () => {
    store.recordUsage('mail', 'gmail', 'open https://mail.google.com');
    expect(store.getPreference('mail')!.status).toBe('probation');

    store.recordUsage('mail', 'gmail', 'open https://mail.google.com');
    expect(store.getPreference('mail')!.status).toBe('active');
    expect(store.getPreference('mail')!.usageCount).toBe(2);
  });

  test('resets to probation when app changes', () => {
    store.recordUsage('mail', 'gmail', 'open https://mail.google.com');
    store.recordUsage('mail', 'gmail', 'open https://mail.google.com');
    expect(store.getPreference('mail')!.status).toBe('active');

    // User switches to outlook
    store.recordUsage('mail', 'outlook', 'open -a "Microsoft Outlook"');
    const pref = store.getPreference('mail');
    expect(pref!.preferredApp).toBe('outlook');
    expect(pref!.usageCount).toBe(1);
    expect(pref!.status).toBe('probation');
  });

  test('getActivePreferences returns only active ones', () => {
    store.recordUsage('mail', 'gmail', 'open https://mail.google.com');
    expect(store.getActivePreferences()).toEqual([]);

    store.recordUsage('mail', 'gmail', 'open https://mail.google.com');
    const active = store.getActivePreferences();
    expect(active).toHaveLength(1);
    expect(active[0]!.preferredApp).toBe('gmail');
  });

  test('formatForPrompt returns empty string when no active preferences', () => {
    expect(store.formatForPrompt()).toBe('');
    store.recordUsage('mail', 'gmail', 'open https://mail.google.com');
    expect(store.formatForPrompt()).toBe('');
  });

  test('formatForPrompt includes active preferences', () => {
    for (let i = 0; i < 2; i++) {
      store.recordUsage('mail', 'gmail', 'open https://mail.google.com');
    }
    const prompt = store.formatForPrompt();
    expect(prompt).toContain('User app preferences');
    expect(prompt).toContain('gmail');
    expect(prompt).toContain('mail');
    expect(prompt).toContain('2 times');
  });

  test('persists across store instances', () => {
    store.recordUsage('mail', 'gmail', 'open https://mail.google.com');
    store.recordUsage('mail', 'gmail', 'open https://mail.google.com');

    // Create a new store from the same DB
    const store2 = new UserPreferenceStore(db);
    const pref = store2.getPreference('mail');
    expect(pref).toBeDefined();
    expect(pref!.preferredApp).toBe('gmail');
    expect(pref!.status).toBe('active');
    expect(pref!.usageCount).toBe(2);
  });

  test('updates resolved_command on repeated usage', () => {
    store.recordUsage('mail', 'gmail', 'open https://mail.google.com');
    store.recordUsage('mail', 'gmail', 'open https://mail.google.com/inbox');
    expect(store.getPreference('mail')!.resolvedCommand).toBe('open https://mail.google.com/inbox');
  });
});

describe('End-to-end: learn → recall cycle', () => {
  let db: Database;
  let store: UserPreferenceStore;

  beforeEach(() => {
    db = new Database(':memory:');
    store = new UserPreferenceStore(db);
  });

  afterEach(() => {
    db.close();
  });

  test('learns from explicit app usage and serves category queries', () => {
    // User says "เปิด Gmail" 2 times — system learns
    const specificApp = extractSpecificApp('เปิด Gmail');
    expect(specificApp).toBe('gmail');
    const category = detectAppCategory('เปิด Gmail');
    expect(category).toBe('mail');

    for (let i = 0; i < 2; i++) {
      store.recordUsage(category!, specificApp!, 'open https://mail.google.com');
    }

    // Now user says "แอพ mail" (category, not specific) — system recalls preference
    expect(isGoalCategoryLevel('แอพ mail')).toBe(true);
    const mailCategory = detectAppCategory('แอพ mail');
    expect(mailCategory).toBe('mail');

    const pref = store.getPreference(mailCategory!);
    expect(pref).toBeDefined();
    expect(pref!.status).toBe('active');
    expect(pref!.preferredApp).toBe('gmail');
    expect(pref!.resolvedCommand).toBe('open https://mail.google.com');
  });

  test('switching apps resets learning', () => {
    // User prefers Gmail for mail (active)
    for (let i = 0; i < 2; i++) {
      store.recordUsage('mail', 'gmail', 'open https://mail.google.com');
    }
    expect(store.getPreference('mail')!.status).toBe('active');

    // User starts using Outlook
    store.recordUsage('mail', 'outlook', 'open -a "Microsoft Outlook"');
    const pref = store.getPreference('mail')!;
    expect(pref.preferredApp).toBe('outlook');
    expect(pref.status).toBe('probation');
    expect(pref.usageCount).toBe(1);

    // Probation preferences are still usable (but not in active list or prompt)
    expect(store.getActivePreferences()).toEqual([]);
    expect(store.formatForPrompt()).toBe('');
  });

  test('multiple categories tracked independently', () => {
    for (let i = 0; i < 2; i++) {
      store.recordUsage('mail', 'gmail', 'open https://mail.google.com');
      store.recordUsage('browser', 'chrome', 'open -a "Google Chrome"');
    }

    expect(store.getActivePreferences()).toHaveLength(2);

    const mailPref = store.getPreference('mail');
    expect(mailPref!.preferredApp).toBe('gmail');

    const browserPref = store.getPreference('browser');
    expect(browserPref!.preferredApp).toBe('chrome');
  });
});
