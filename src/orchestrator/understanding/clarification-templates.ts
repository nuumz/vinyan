/**
 * Clarification question templates — a small library of commonly-needed
 * structured questions for creative / content tasks. Lets the orchestrator
 * emit consistent, selectable options across sessions.
 *
 * A3: pure data + deterministic selection logic. No LLM involved.
 */

import type {
  ClarificationOption,
  ClarificationQuestion,
} from '../../core/clarification.ts';

type TemplateId =
  | 'genre'
  | 'audience'
  | 'tone'
  | 'length'
  | 'target-platform'
  | 'writing-style';

interface Template {
  id: TemplateId;
  build(context: TemplateContext): ClarificationQuestion | null;
}

export interface TemplateContext {
  /** Bucket the templates need to pick the right option set. */
  creativeDomain?: 'webtoon' | 'novel' | 'article' | 'video' | 'generic';
  /** Fields the user (or prior turns) already supplied — skip them. */
  knownFields?: Set<TemplateId>;
  /**
   * User interest signals from UserInterestMiner — lets templates hint at
   * genres/tones the user has touched before (optional Phase B enhancement).
   */
  recentKeywords?: string[];
}

const WEBTOON_GENRE_OPTIONS: ClarificationOption[] = [
  { id: 'romance-fantasy', label: 'โรแมนติก-แฟนตาซี', hint: 'นางเอกเข้าไปในโลกนิยาย / ชะตากรรมพลิกผัน' },
  { id: 'action-system', label: 'แอ็กชัน-ระบบ (Level up)', hint: 'พระเอกได้ระบบพิเศษ ต่อสู้ดันเจี้ยน' },
  { id: 'thriller-psych', label: 'ระทึกขวัญ-จิตวิทยา', hint: 'คดีปริศนา เกมเอาชีวิตรอด' },
  { id: 'slice-of-life', label: 'ชีวิตประจำวัน/คอมเมดี้', hint: 'ออฟฟิศ/ในรั้วมหาวิทยาลัย' },
  { id: 'historical', label: 'พีเรียดย้อนยุค', hint: 'ราชสำนัก / ย้อนเวลา' },
];

const NOVEL_GENRE_OPTIONS: ClarificationOption[] = [
  { id: 'romance', label: 'โรแมนติก' },
  { id: 'fantasy', label: 'แฟนตาซี' },
  { id: 'scifi', label: 'ไซไฟ' },
  { id: 'mystery', label: 'สืบสวน-ระทึกขวัญ' },
  { id: 'literary', label: 'วรรณกรรมร่วมสมัย' },
];

const ARTICLE_GENRE_OPTIONS: ClarificationOption[] = [
  { id: 'how-to', label: 'How-to / Tutorial' },
  { id: 'opinion', label: 'บทความแสดงความเห็น' },
  { id: 'analysis', label: 'วิเคราะห์เชิงลึก' },
  { id: 'listicle', label: 'Listicle / สรุปเป็นข้อๆ' },
];

const AUDIENCE_OPTIONS: ClarificationOption[] = [
  { id: 'teen', label: 'วัยรุ่น (13-18)' },
  { id: 'young-adult', label: 'Young Adult (18-25)' },
  { id: 'adult', label: 'ผู้ใหญ่ (25+)' },
  { id: 'all-ages', label: 'ทุกวัย' },
];

const TONE_OPTIONS: ClarificationOption[] = [
  { id: 'serious', label: 'จริงจัง / ดราม่า' },
  { id: 'humorous', label: 'ตลก / เบาสมอง' },
  { id: 'dark', label: 'มืดหม่น / ดาร์ก' },
  { id: 'heartwarming', label: 'อบอุ่นหัวใจ' },
  { id: 'tense', label: 'ตึงเครียด / ระทึก' },
];

const LENGTH_OPTIONS_WEBTOON: ClarificationOption[] = [
  { id: 'short-run', label: 'ซีรีส์สั้น (20-40 ตอน)' },
  { id: 'medium-run', label: 'ซีรีส์กลาง (40-100 ตอน)' },
  { id: 'long-run', label: 'ซีรีส์ยาว (100+ ตอน)' },
];

const LENGTH_OPTIONS_GENERIC: ClarificationOption[] = [
  { id: 'short', label: 'สั้น (1-2 หน้า / 500 คำ)' },
  { id: 'medium', label: 'กลาง (3-5 หน้า / 1000-2000 คำ)' },
  { id: 'long', label: 'ยาว (5+ หน้า / 3000+ คำ)' },
];

const PLATFORM_OPTIONS: ClarificationOption[] = [
  { id: 'webtoon', label: 'LINE WEBTOON' },
  { id: 'tapas', label: 'Tapas' },
  { id: 'medium', label: 'Medium' },
  { id: 'blog', label: 'บล็อกส่วนตัว' },
  { id: 'facebook', label: 'Facebook Page' },
  { id: 'self-publish', label: 'Self-publish (ebook)' },
];

const templates: Template[] = [
  {
    id: 'genre',
    build({ creativeDomain }) {
      let options: ClarificationOption[] = [];
      if (creativeDomain === 'webtoon') options = WEBTOON_GENRE_OPTIONS;
      else if (creativeDomain === 'novel') options = NOVEL_GENRE_OPTIONS;
      else if (creativeDomain === 'article') options = ARTICLE_GENRE_OPTIONS;
      else options = [...NOVEL_GENRE_OPTIONS, ...ARTICLE_GENRE_OPTIONS.slice(0, 2)];
      return {
        id: 'genre',
        prompt: 'อยากได้แนวเรื่องแบบไหนครับ?',
        kind: 'single',
        options,
        allowFreeText: true,
      };
    },
  },
  {
    id: 'audience',
    build() {
      return {
        id: 'audience',
        prompt: 'กลุ่มผู้อ่านเป้าหมายเป็นใคร?',
        kind: 'single',
        options: AUDIENCE_OPTIONS,
        allowFreeText: true,
      };
    },
  },
  {
    id: 'tone',
    build() {
      return {
        id: 'tone',
        prompt: 'อยากให้โทนเรื่องออกแนวไหน? (เลือกได้มากกว่าหนึ่ง)',
        kind: 'multi',
        options: TONE_OPTIONS,
        allowFreeText: true,
        maxSelections: 3,
      };
    },
  },
  {
    id: 'length',
    build({ creativeDomain }) {
      const options =
        creativeDomain === 'webtoon' ? LENGTH_OPTIONS_WEBTOON : LENGTH_OPTIONS_GENERIC;
      return {
        id: 'length',
        prompt: 'วางแผนความยาวของเรื่องเท่าไหร่?',
        kind: 'single',
        options,
        allowFreeText: true,
      };
    },
  },
  {
    id: 'target-platform',
    build() {
      return {
        id: 'target-platform',
        prompt: 'วางแผนเผยแพร่ที่แพลตฟอร์มไหน? (เลือกได้มากกว่าหนึ่ง)',
        kind: 'multi',
        options: PLATFORM_OPTIONS,
        allowFreeText: true,
      };
    },
  },
];

export function buildClarificationSet(context: TemplateContext): ClarificationQuestion[] {
  const known = context.knownFields ?? new Set<TemplateId>();
  const out: ClarificationQuestion[] = [];
  for (const tmpl of templates) {
    if (known.has(tmpl.id)) continue;
    const q = tmpl.build(context);
    if (q) out.push(q);
  }
  return out;
}

export function buildGenreQuestion(
  domain: TemplateContext['creativeDomain'] = 'generic',
): ClarificationQuestion | null {
  const tmpl = templates.find((t) => t.id === 'genre');
  return tmpl?.build({ creativeDomain: domain }) ?? null;
}

/**
 * Infer the creative domain from a user goal. Returns 'generic' when the goal
 * doesn't match any specialized domain so callers still get a reasonable
 * default genre set.
 */
export function inferCreativeDomain(goal: string): TemplateContext['creativeDomain'] {
  const lower = goal.toLowerCase();
  if (/(เว็บตูน|webtoon|การ์ตูน|tapas)/i.test(lower)) return 'webtoon';
  if (/(นิยาย|novel|เรื่องสั้น|เรื่องยาว|short story|literary)/i.test(lower)) return 'novel';
  if (/(บทความ|article|blog|essay|post|newsletter)/i.test(lower)) return 'article';
  if (/(คลิป|วิดีโอ|video|tiktok|reel|youtube|podcast)/i.test(lower)) return 'video';
  return 'generic';
}
