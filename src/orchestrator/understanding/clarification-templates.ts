/**
 * Clarification question templates — a small library of commonly-needed
 * structured questions for creative / content tasks. Lets the orchestrator
 * emit consistent, selectable options across sessions.
 *
 * A3: pure data + deterministic selection logic. No LLM involved.
 *
 * Architecture (post-Phase 2 expansion).
 *
 * Each creative domain (`webtoon`, `novel`, `video`, `music`, `game`,
 * `marketing`, `education`, `business`, `visual`, `article`, `generic`)
 * maps to a `DomainProfile` containing the option sets + prompt phrasing
 * for the five clarification slots: genre, audience, tone, length,
 * target-platform. Adding a new domain = registering one entry in
 * `DOMAIN_PROFILES`. Template builders read from the profile and never
 * branch on the domain string directly.
 *
 * Ordering of `inferCreativeDomain` patterns matters — more specific
 * compounds (e.g. "วิดีโอเกม", "เพลงประกอบเกม") fire BEFORE the broader
 * single-word domain (`game` before `video`/`music`). Generic creative
 * domains (article/blog) come AFTER specialised ones so a "blog post
 * about a video game" picks `game` if the artifact noun is the game,
 * not the blog.
 */

import type { ClarificationOption, ClarificationQuestion } from '../../core/clarification.ts';

type TemplateId = 'genre' | 'audience' | 'tone' | 'length' | 'target-platform' | 'writing-style';

interface Template {
  id: TemplateId;
  build(context: TemplateContext): ClarificationQuestion | null;
}

/** All creative domains the orchestrator knows how to clarify. */
export type CreativeDomain =
  | 'webtoon'
  | 'novel'
  | 'article'
  | 'video'
  | 'music'
  | 'game'
  | 'marketing'
  | 'education'
  | 'business'
  | 'visual'
  | 'generic';

export interface TemplateContext {
  /** Bucket the templates need to pick the right option set. */
  creativeDomain?: CreativeDomain;
  /** Fields the user (or prior turns) already supplied — skip them. */
  knownFields?: Set<TemplateId>;
  /**
   * User interest signals from UserInterestMiner — lets templates hint at
   * genres/tones the user has touched before (optional Phase B enhancement).
   */
  recentKeywords?: string[];
}

// ── Genre / type / category options ────────────────────────────────────

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

const VIDEO_GENRE_OPTIONS: ClarificationOption[] = [
  { id: 'comedy', label: 'ตลก / Comedy / Skit', hint: 'มุกสั้น / เสียดสี / สถานการณ์ขำขัน' },
  { id: 'lifestyle', label: 'Lifestyle / Vlog', hint: 'กิจวัตร / Day in life / OOTD' },
  { id: 'education', label: 'Education / Tips', hint: 'สอนทักษะ / ข้อมูลน่ารู้สั้นๆ' },
  { id: 'beauty', label: 'Beauty / Skincare / Fashion', hint: 'รีวิว / สอนแต่งหน้า / Try-on' },
  { id: 'food', label: 'Food / Cooking / Eating', hint: 'รีวิวร้าน / Recipe / Mukbang' },
  { id: 'dance', label: 'Dance / Music / Performance' },
  { id: 'tech-review', label: 'Tech / Gadget Review' },
  { id: 'travel', label: 'Travel / Places' },
  { id: 'fitness', label: 'Fitness / Health' },
  { id: 'pet', label: 'Pet / Animals' },
  { id: 'business', label: 'Business / Side-hustle / Productivity' },
  { id: 'storytelling', label: 'Storytime / Narrative' },
];

const MUSIC_GENRE_OPTIONS: ClarificationOption[] = [
  { id: 'pop', label: 'Pop / T-Pop' },
  { id: 'rock', label: 'Rock / Alternative' },
  { id: 'hiphop', label: 'Hip-hop / Rap / R&B' },
  { id: 'edm', label: 'EDM / Dance / House' },
  { id: 'acoustic', label: 'Acoustic / Folk / Singer-songwriter' },
  { id: 'lofi', label: 'Lo-fi / Chillhop / Ambient' },
  { id: 'jazz', label: 'Jazz / Bossa / Blues' },
  { id: 'orchestral', label: 'Orchestral / Cinematic / Score' },
  { id: 'jingle', label: 'Jingle / Brand sting / Logo motif' },
  { id: 'lullaby', label: 'Lullaby / Children / Educational' },
];

const GAME_GENRE_OPTIONS: ClarificationOption[] = [
  { id: 'platformer', label: 'Platformer / Action-platformer' },
  { id: 'rpg', label: 'RPG / JRPG / Tactical' },
  { id: 'puzzle', label: 'Puzzle / Logic' },
  { id: 'shooter', label: 'Shooter / FPS / TPS' },
  { id: 'strategy', label: 'Strategy / 4X / RTS' },
  { id: 'simulation', label: 'Simulation / Tycoon / Life-sim' },
  { id: 'visual-novel', label: 'Visual Novel / Narrative' },
  { id: 'roguelike', label: 'Roguelike / Roguelite' },
  { id: 'horror', label: 'Horror / Survival' },
  { id: 'sandbox', label: 'Sandbox / Open-world' },
  { id: 'party', label: 'Party / Casual / Hyper-casual' },
];

const MARKETING_GENRE_OPTIONS: ClarificationOption[] = [
  { id: 'brand-awareness', label: 'Brand awareness / สร้างการรับรู้' },
  { id: 'product-launch', label: 'Product launch / เปิดตัวสินค้า' },
  { id: 'promotion', label: 'Promotion / Sale / ลดราคา' },
  { id: 'lead-gen', label: 'Lead-gen / เก็บลูกค้าใหม่' },
  { id: 'retention', label: 'Retention / รักษาลูกค้าเก่า' },
  { id: 'thought-leadership', label: 'Thought leadership / Educational' },
  { id: 'event', label: 'Event / Webinar / Activation' },
  { id: 'rebrand', label: 'Rebrand / Repositioning' },
];

const EDUCATION_GENRE_OPTIONS: ClarificationOption[] = [
  { id: 'video-lesson', label: 'Video lesson / บทเรียนวิดีโอ' },
  { id: 'written-guide', label: 'Written guide / E-book / PDF' },
  { id: 'interactive', label: 'Interactive (quiz, exercise, lab)' },
  { id: 'workshop', label: 'Workshop / Live class' },
  { id: 'slide-deck', label: 'Slide deck / Lecture' },
  { id: 'case-study', label: 'Case study / Worked example' },
  { id: 'cohort-course', label: 'Cohort-based course / Bootcamp' },
  { id: 'self-paced', label: 'Self-paced course / MOOC' },
];

const BUSINESS_GENRE_OPTIONS: ClarificationOption[] = [
  { id: 'pitch-deck', label: 'Pitch deck' },
  { id: 'business-plan', label: 'Business plan / แผนธุรกิจ' },
  { id: 'one-pager', label: 'One-pager / Executive summary' },
  { id: 'proposal', label: 'Proposal / RFP response' },
  { id: 'memo', label: 'Internal memo / Brief' },
  { id: 'okr-doc', label: 'OKR / KPI doc' },
  { id: 'strategy-brief', label: 'Strategy brief / Vision doc' },
  { id: 'market-analysis', label: 'Market / competitor analysis' },
];

const VISUAL_GENRE_OPTIONS: ClarificationOption[] = [
  { id: 'logo', label: 'Logo / Wordmark / Monogram' },
  { id: 'poster', label: 'Poster / Event flyer' },
  { id: 'infographic', label: 'Infographic / Data visualization' },
  { id: 'social-banner', label: 'Social banner / Cover image' },
  { id: 'app-icon', label: 'App icon / Icon set' },
  { id: 'illustration', label: 'Illustration / Editorial art' },
  { id: 'brand-identity', label: 'Brand identity / Style guide' },
  { id: 'product-mockup', label: 'Product mockup / Packaging' },
];

// ── Audience ───────────────────────────────────────────────────────────

const AUDIENCE_OPTIONS_AGE: ClarificationOption[] = [
  { id: 'teen', label: 'วัยรุ่น (13-18)' },
  { id: 'young-adult', label: 'Young Adult (18-25)' },
  { id: 'adult', label: 'ผู้ใหญ่ (25+)' },
  { id: 'all-ages', label: 'ทุกวัย' },
];

const AUDIENCE_OPTIONS_GAME: ClarificationOption[] = [
  { id: 'casual', label: 'Casual player' },
  { id: 'mid-core', label: 'Mid-core / Hobbyist' },
  { id: 'hardcore', label: 'Hardcore / Competitive' },
  { id: 'family', label: 'Family / All-ages' },
  { id: 'mature', label: 'Mature / 18+' },
];

const AUDIENCE_OPTIONS_BUSINESS: ClarificationOption[] = [
  { id: 'investors', label: 'Investors / VCs / Angels' },
  { id: 'board', label: 'Board / Executive team' },
  { id: 'internal', label: 'Internal team / Staff' },
  { id: 'customers', label: 'Customers / End-users' },
  { id: 'partners', label: 'Partners / Channel' },
  { id: 'b2b', label: 'B2B decision-makers' },
];

const AUDIENCE_OPTIONS_EDUCATION: ClarificationOption[] = [
  { id: 'beginner', label: 'Beginner / มือใหม่' },
  { id: 'intermediate', label: 'Intermediate / กลาง' },
  { id: 'advanced', label: 'Advanced / ขั้นสูง' },
  { id: 'k12', label: 'K-12 / นักเรียน' },
  { id: 'college', label: 'College / มหาวิทยาลัย' },
  { id: 'adult-learner', label: 'Adult learner / Working professional' },
];

// ── Tone ───────────────────────────────────────────────────────────────

const TONE_OPTIONS_NARRATIVE: ClarificationOption[] = [
  { id: 'serious', label: 'จริงจัง / ดราม่า' },
  { id: 'humorous', label: 'ตลก / เบาสมอง' },
  { id: 'dark', label: 'มืดหม่น / ดาร์ก' },
  { id: 'heartwarming', label: 'อบอุ่นหัวใจ' },
  { id: 'tense', label: 'ตึงเครียด / ระทึก' },
];

const TONE_OPTIONS_MARKETING: ClarificationOption[] = [
  { id: 'inspirational', label: 'สร้างแรงบันดาลใจ' },
  { id: 'urgent', label: 'เร่งด่วน / Limited' },
  { id: 'casual', label: 'สบายๆ / Friendly' },
  { id: 'professional', label: 'มืออาชีพ / Trustworthy' },
  { id: 'edgy', label: 'แหลม / Bold / Edgy' },
  { id: 'humorous', label: 'ตลก / Witty' },
  { id: 'data-driven', label: 'Data-driven / Analytical' },
];

const TONE_OPTIONS_BUSINESS: ClarificationOption[] = [
  { id: 'confident', label: 'มั่นใจ / Visionary' },
  { id: 'data-driven', label: 'Data-driven / Conservative' },
  { id: 'urgent', label: 'เร่งด่วน / Crisis' },
  { id: 'optimistic', label: 'มองโลกในแง่ดี' },
  { id: 'cautious', label: 'รอบคอบ / Risk-aware' },
  { id: 'bold', label: 'กล้าหาญ / Disruptive' },
];

const TONE_OPTIONS_VISUAL: ClarificationOption[] = [
  { id: 'modern', label: 'Modern / Clean' },
  { id: 'minimalist', label: 'Minimalist / Less-is-more' },
  { id: 'vintage', label: 'Vintage / Retro' },
  { id: 'playful', label: 'Playful / Whimsical' },
  { id: 'corporate', label: 'Corporate / Trustworthy' },
  { id: 'bold', label: 'Bold / High-contrast' },
  { id: 'organic', label: 'Organic / Hand-drawn' },
];

// ── Length / duration / size ───────────────────────────────────────────

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

const LENGTH_OPTIONS_VIDEO: ClarificationOption[] = [
  { id: 'micro', label: 'Micro (≤15 วินาที — hook-only / loop)' },
  { id: 'short-clip', label: 'สั้น (15-30 วินาที — TikTok / Reels)' },
  { id: 'standard', label: 'กลาง (30-60 วินาที — มาตรฐาน TikTok)' },
  { id: 'extended', label: 'ยาว (1-3 นาที — TikTok long / YouTube Short)' },
  { id: 'long-form', label: 'ยาวกว่านี้ (3+ นาที — YouTube long-form / Podcast clip)' },
];

const LENGTH_OPTIONS_MUSIC: ClarificationOption[] = [
  { id: 'sting', label: 'Sting / Logo (3-7 วินาที)' },
  { id: 'jingle', label: 'Jingle (15-30 วินาที)' },
  { id: 'hook', label: 'Hook / Snippet (30-60 วินาที — TikTok-clip)' },
  { id: 'single', label: 'Single track (2-4 นาที)' },
  { id: 'extended-track', label: 'Extended track / Mix (4-7 นาที)' },
  { id: 'loop', label: 'Background loop (เล่นวนได้)' },
];

const LENGTH_OPTIONS_GAME: ClarificationOption[] = [
  { id: 'micro', label: 'Mini-game / Web (5-30 นาที)' },
  { id: 'short', label: 'Short game (1-3 ชม. — game jam)' },
  { id: 'medium', label: 'Medium (5-10 ชม.)' },
  { id: 'long', label: 'Long campaign (20-40 ชม.)' },
  { id: 'live-service', label: 'Live-service / Endless' },
];

const LENGTH_OPTIONS_MARKETING: ClarificationOption[] = [
  { id: 'tagline', label: 'Tagline / Slogan (1 บรรทัด)' },
  { id: 'short-copy', label: 'Short copy (banner / display ad)' },
  { id: 'social-post', label: 'Social post (caption + image, 50-150 คำ)' },
  { id: 'email', label: 'Email body (200-500 คำ)' },
  { id: 'landing-page', label: 'Landing page (full page copy)' },
  { id: 'campaign-brief', label: 'Campaign brief (multi-asset)' },
];

const LENGTH_OPTIONS_EDUCATION: ClarificationOption[] = [
  { id: 'single-lesson', label: 'Single lesson (15-30 นาที)' },
  { id: 'short-course', label: 'Short course (1-2 ชม. รวม)' },
  { id: 'full-course', label: 'Full course (5-10 ชม.)' },
  { id: 'series', label: 'Series / multi-module (20+ บทเรียน)' },
  { id: 'bootcamp', label: 'Bootcamp / Cohort (4-12 weeks)' },
];

const LENGTH_OPTIONS_BUSINESS: ClarificationOption[] = [
  { id: 'one-pager', label: 'One-pager (1 หน้า)' },
  { id: 'short-deck', label: 'Short deck (5-10 สไลด์)' },
  { id: 'standard-deck', label: 'Standard deck (15-25 สไลด์)' },
  { id: 'full-report', label: 'Full report (10+ หน้า)' },
  { id: 'long-form', label: 'Long-form / Whitepaper (20+ หน้า)' },
];

const LENGTH_OPTIONS_VISUAL: ClarificationOption[] = [
  { id: 'square', label: 'Square 1:1 (Instagram post)' },
  { id: 'portrait', label: 'Portrait 9:16 (Story / Reel cover)' },
  { id: 'landscape', label: 'Landscape 16:9 (YouTube / web banner)' },
  { id: 'a4', label: 'A4 / Letter (print)' },
  { id: 'large-format', label: 'Large format (poster / billboard)' },
  { id: 'icon-small', label: 'Small icon (≤512px)' },
];

// ── Platform / distribution ────────────────────────────────────────────

const PLATFORM_OPTIONS_TEXT: ClarificationOption[] = [
  { id: 'webtoon', label: 'LINE WEBTOON' },
  { id: 'tapas', label: 'Tapas' },
  { id: 'medium', label: 'Medium' },
  { id: 'blog', label: 'บล็อกส่วนตัว' },
  { id: 'facebook', label: 'Facebook Page' },
  { id: 'self-publish', label: 'Self-publish (ebook)' },
];

const PLATFORM_OPTIONS_VIDEO: ClarificationOption[] = [
  { id: 'tiktok', label: 'TikTok' },
  { id: 'instagram-reels', label: 'Instagram Reels' },
  { id: 'youtube-shorts', label: 'YouTube Shorts' },
  { id: 'facebook-reels', label: 'Facebook Reels' },
  { id: 'youtube-long', label: 'YouTube (long-form)' },
  { id: 'podcast', label: 'Podcast / Audio' },
];

const PLATFORM_OPTIONS_MUSIC: ClarificationOption[] = [
  { id: 'spotify', label: 'Spotify' },
  { id: 'apple-music', label: 'Apple Music' },
  { id: 'youtube-music', label: 'YouTube Music' },
  { id: 'soundcloud', label: 'SoundCloud' },
  { id: 'tiktok-clip', label: 'TikTok / Reels clip' },
  { id: 'sync-license', label: 'Sync license (TV / film / ad)' },
  { id: 'live-perf', label: 'Live performance / Bandcamp' },
];

const PLATFORM_OPTIONS_GAME: ClarificationOption[] = [
  { id: 'mobile-ios', label: 'Mobile — iOS' },
  { id: 'mobile-android', label: 'Mobile — Android' },
  { id: 'pc-steam', label: 'PC — Steam' },
  { id: 'pc-itchio', label: 'PC — itch.io / indie' },
  { id: 'console', label: 'Console (PS / Xbox / Switch)' },
  { id: 'web', label: 'Web browser / HTML5' },
  { id: 'vr-ar', label: 'VR / AR' },
];

const PLATFORM_OPTIONS_MARKETING: ClarificationOption[] = [
  { id: 'meta', label: 'Meta (Facebook / Instagram)' },
  { id: 'tiktok-ads', label: 'TikTok Ads' },
  { id: 'google-ads', label: 'Google Ads / YouTube' },
  { id: 'linkedin', label: 'LinkedIn' },
  { id: 'email', label: 'Email / Newsletter' },
  { id: 'line', label: 'LINE OA / LINE Ads' },
  { id: 'print', label: 'Print / Out-of-home' },
  { id: 'website', label: 'Website / Landing page' },
];

const PLATFORM_OPTIONS_EDUCATION: ClarificationOption[] = [
  { id: 'youtube', label: 'YouTube (free / channel)' },
  { id: 'udemy', label: 'Udemy / Coursera / EdX' },
  { id: 'linkedin-learning', label: 'LinkedIn Learning' },
  { id: 'in-house-lms', label: 'In-house LMS / Internal training' },
  { id: 'school', label: 'School / University LMS' },
  { id: 'live-cohort', label: 'Live cohort (Maven / Discord)' },
  { id: 'pdf-ebook', label: 'PDF / E-book' },
];

const PLATFORM_OPTIONS_BUSINESS: ClarificationOption[] = [
  { id: 'pdf', label: 'PDF (export)' },
  { id: 'powerpoint', label: 'PowerPoint / Keynote / Slides' },
  { id: 'notion', label: 'Notion / Confluence' },
  { id: 'doc', label: 'Google Doc / Word' },
  { id: 'memo-email', label: 'Memo / Email format' },
  { id: 'figma', label: 'Figma / Pitch.com (designed deck)' },
];

const PLATFORM_OPTIONS_VISUAL: ClarificationOption[] = [
  { id: 'instagram', label: 'Instagram' },
  { id: 'facebook', label: 'Facebook' },
  { id: 'twitter-x', label: 'X (Twitter)' },
  { id: 'website', label: 'Website / Web banner' },
  { id: 'print', label: 'Print (poster, packaging, signage)' },
  { id: 'app-store', label: 'App / Play Store (icon, screenshot)' },
  { id: 'brand-asset', label: 'Brand asset / Internal style guide' },
];

// ── Domain profile registry ────────────────────────────────────────────

interface DomainProfile {
  /** Verb language and prompt phrasing for genre / tone / length / platform. */
  genrePrompt: string;
  genreOptions: ClarificationOption[];
  audiencePrompt: string;
  /** Defaults to AUDIENCE_OPTIONS_AGE when omitted. */
  audienceOptions?: ClarificationOption[];
  tonePrompt: string;
  /** Defaults to TONE_OPTIONS_NARRATIVE when omitted. */
  toneOptions?: ClarificationOption[];
  lengthPrompt: string;
  lengthOptions: ClarificationOption[];
  platformPrompt: string;
  platformOptions: ClarificationOption[];
}

const PLATFORM_PROMPT_DEFAULT = 'วางแผนเผยแพร่ที่แพลตฟอร์มไหน? (เลือกได้มากกว่าหนึ่ง)';

const DOMAIN_PROFILES: Record<CreativeDomain, DomainProfile> = {
  webtoon: {
    genrePrompt: 'อยากได้แนวเรื่องแบบไหนครับ?',
    genreOptions: WEBTOON_GENRE_OPTIONS,
    audiencePrompt: 'กลุ่มผู้อ่านเป้าหมายเป็นใคร?',
    tonePrompt: 'อยากให้โทนเรื่องออกแนวไหน? (เลือกได้มากกว่าหนึ่ง)',
    lengthPrompt: 'วางแผนความยาวของเรื่องเท่าไหร่?',
    lengthOptions: LENGTH_OPTIONS_WEBTOON,
    platformPrompt: PLATFORM_PROMPT_DEFAULT,
    platformOptions: PLATFORM_OPTIONS_TEXT,
  },
  novel: {
    genrePrompt: 'อยากได้แนวเรื่องแบบไหนครับ?',
    genreOptions: NOVEL_GENRE_OPTIONS,
    audiencePrompt: 'กลุ่มผู้อ่านเป้าหมายเป็นใคร?',
    tonePrompt: 'อยากให้โทนเรื่องออกแนวไหน? (เลือกได้มากกว่าหนึ่ง)',
    lengthPrompt: 'วางแผนความยาวของเรื่องเท่าไหร่?',
    lengthOptions: LENGTH_OPTIONS_GENERIC,
    platformPrompt: PLATFORM_PROMPT_DEFAULT,
    platformOptions: PLATFORM_OPTIONS_TEXT,
  },
  article: {
    genrePrompt: 'อยากได้บทความแนวไหนครับ?',
    genreOptions: ARTICLE_GENRE_OPTIONS,
    audiencePrompt: 'กลุ่มผู้อ่านเป้าหมายเป็นใคร?',
    tonePrompt: 'อยากให้โทนบทความออกแนวไหน? (เลือกได้มากกว่าหนึ่ง)',
    lengthPrompt: 'วางแผนความยาวบทความเท่าไหร่?',
    lengthOptions: LENGTH_OPTIONS_GENERIC,
    platformPrompt: PLATFORM_PROMPT_DEFAULT,
    platformOptions: PLATFORM_OPTIONS_TEXT,
  },
  video: {
    genrePrompt: 'อยากได้คอนเทนต์แนวไหนครับ?',
    genreOptions: VIDEO_GENRE_OPTIONS,
    audiencePrompt: 'กลุ่มผู้ชมเป้าหมายเป็นใคร?',
    tonePrompt: 'อยากให้โทนคลิปออกแนวไหน? (เลือกได้มากกว่าหนึ่ง)',
    lengthPrompt: 'ความยาวคลิปประมาณเท่าไหร่ครับ?',
    lengthOptions: LENGTH_OPTIONS_VIDEO,
    platformPrompt: 'วางแผนเผยแพร่ที่แพลตฟอร์มไหน? (เลือกได้มากกว่าหนึ่ง)',
    platformOptions: PLATFORM_OPTIONS_VIDEO,
  },
  music: {
    genrePrompt: 'อยากได้เพลงแนวไหนครับ?',
    genreOptions: MUSIC_GENRE_OPTIONS,
    audiencePrompt: 'กลุ่มผู้ฟังเป้าหมายเป็นใคร?',
    tonePrompt: 'อยากให้โทนเพลงออกแนวไหน? (เลือกได้มากกว่าหนึ่ง)',
    lengthPrompt: 'ความยาว / รูปแบบเพลงประมาณเท่าไหร่ครับ?',
    lengthOptions: LENGTH_OPTIONS_MUSIC,
    platformPrompt: 'วางแผนเผยแพร่ที่แพลตฟอร์มไหน? (เลือกได้มากกว่าหนึ่ง)',
    platformOptions: PLATFORM_OPTIONS_MUSIC,
  },
  game: {
    genrePrompt: 'เกมแนวไหนครับ?',
    genreOptions: GAME_GENRE_OPTIONS,
    audiencePrompt: 'กลุ่มผู้เล่นเป้าหมายเป็นใคร?',
    audienceOptions: AUDIENCE_OPTIONS_GAME,
    tonePrompt: 'โทน / บรรยากาศของเกมเป็นแบบไหน? (เลือกได้มากกว่าหนึ่ง)',
    lengthPrompt: 'ขอบเขต / ความยาวของเกมประมาณเท่าไหร่ครับ?',
    lengthOptions: LENGTH_OPTIONS_GAME,
    platformPrompt: 'วางแผนปล่อยที่แพลตฟอร์มไหนครับ? (เลือกได้มากกว่าหนึ่ง)',
    platformOptions: PLATFORM_OPTIONS_GAME,
  },
  marketing: {
    genrePrompt: 'แคมเปญ/วัตถุประสงค์เป็นอะไรครับ?',
    genreOptions: MARKETING_GENRE_OPTIONS,
    audiencePrompt: 'กลุ่มเป้าหมายของแคมเปญคือใคร?',
    tonePrompt: 'อยากให้ข้อความออกโทนไหน? (เลือกได้มากกว่าหนึ่ง)',
    toneOptions: TONE_OPTIONS_MARKETING,
    lengthPrompt: 'รูปแบบ/ความยาวข้อความประมาณเท่าไหร่ครับ?',
    lengthOptions: LENGTH_OPTIONS_MARKETING,
    platformPrompt: 'แพลตฟอร์มที่จะลงโฆษณา/คอนเทนต์ (เลือกได้มากกว่าหนึ่ง)',
    platformOptions: PLATFORM_OPTIONS_MARKETING,
  },
  education: {
    genrePrompt: 'รูปแบบ/ฟอร์แมตของบทเรียนเป็นแบบไหน?',
    genreOptions: EDUCATION_GENRE_OPTIONS,
    audiencePrompt: 'ระดับ/กลุ่มผู้เรียนเป้าหมายเป็นใคร?',
    audienceOptions: AUDIENCE_OPTIONS_EDUCATION,
    tonePrompt: 'อยากให้โทนการสอนออกแนวไหน? (เลือกได้มากกว่าหนึ่ง)',
    lengthPrompt: 'ความยาว / ขอบเขตของบทเรียนเท่าไหร่ครับ?',
    lengthOptions: LENGTH_OPTIONS_EDUCATION,
    platformPrompt: 'แพลตฟอร์มที่ตั้งใจจะปล่อย (เลือกได้มากกว่าหนึ่ง)',
    platformOptions: PLATFORM_OPTIONS_EDUCATION,
  },
  business: {
    genrePrompt: 'เอกสารประเภทไหนครับ?',
    genreOptions: BUSINESS_GENRE_OPTIONS,
    audiencePrompt: 'กลุ่มผู้อ่าน/ผู้ตัดสินใจเป็นใคร?',
    audienceOptions: AUDIENCE_OPTIONS_BUSINESS,
    tonePrompt: 'อยากให้โทนเอกสารออกแนวไหน? (เลือกได้มากกว่าหนึ่ง)',
    toneOptions: TONE_OPTIONS_BUSINESS,
    lengthPrompt: 'ความยาว/รูปแบบเอกสารเท่าไหร่ครับ?',
    lengthOptions: LENGTH_OPTIONS_BUSINESS,
    platformPrompt: 'รูปแบบที่จะส่งมอบ (เลือกได้มากกว่าหนึ่ง)',
    platformOptions: PLATFORM_OPTIONS_BUSINESS,
  },
  visual: {
    genrePrompt: 'อยากได้งานภาพแบบไหนครับ?',
    genreOptions: VISUAL_GENRE_OPTIONS,
    audiencePrompt: 'กลุ่มเป้าหมายที่จะเห็นงานนี้คือใคร?',
    tonePrompt: 'อยากให้สไตล์ภาพออกแนวไหน? (เลือกได้มากกว่าหนึ่ง)',
    toneOptions: TONE_OPTIONS_VISUAL,
    lengthPrompt: 'ขนาด / สัดส่วนงานที่ต้องการ?',
    lengthOptions: LENGTH_OPTIONS_VISUAL,
    platformPrompt: 'จะใช้งานภาพนี้ที่ไหน? (เลือกได้มากกว่าหนึ่ง)',
    platformOptions: PLATFORM_OPTIONS_VISUAL,
  },
  generic: {
    genrePrompt: 'อยากได้แนวเรื่องแบบไหนครับ?',
    // Mix novel + 2 article options as a sensible fallback.
    genreOptions: [...NOVEL_GENRE_OPTIONS, ...ARTICLE_GENRE_OPTIONS.slice(0, 2)],
    audiencePrompt: 'กลุ่มผู้อ่านเป้าหมายเป็นใคร?',
    tonePrompt: 'อยากให้โทนเรื่องออกแนวไหน? (เลือกได้มากกว่าหนึ่ง)',
    lengthPrompt: 'วางแผนความยาวของเรื่องเท่าไหร่?',
    lengthOptions: LENGTH_OPTIONS_GENERIC,
    platformPrompt: PLATFORM_PROMPT_DEFAULT,
    platformOptions: PLATFORM_OPTIONS_TEXT,
  },
};

function getProfile(domain: CreativeDomain | undefined): DomainProfile {
  return DOMAIN_PROFILES[domain ?? 'generic'] ?? DOMAIN_PROFILES.generic;
}

// ── Templates ──────────────────────────────────────────────────────────

const templates: Template[] = [
  {
    id: 'genre',
    build({ creativeDomain }) {
      const p = getProfile(creativeDomain);
      return {
        id: 'genre',
        prompt: p.genrePrompt,
        kind: 'single',
        options: p.genreOptions,
        allowFreeText: true,
      };
    },
  },
  {
    id: 'audience',
    build({ creativeDomain }) {
      const p = getProfile(creativeDomain);
      return {
        id: 'audience',
        prompt: p.audiencePrompt,
        kind: 'single',
        options: p.audienceOptions ?? AUDIENCE_OPTIONS_AGE,
        allowFreeText: true,
      };
    },
  },
  {
    id: 'tone',
    build({ creativeDomain }) {
      const p = getProfile(creativeDomain);
      return {
        id: 'tone',
        prompt: p.tonePrompt,
        kind: 'multi',
        options: p.toneOptions ?? TONE_OPTIONS_NARRATIVE,
        allowFreeText: true,
        maxSelections: 3,
      };
    },
  },
  {
    id: 'length',
    build({ creativeDomain }) {
      const p = getProfile(creativeDomain);
      return {
        id: 'length',
        prompt: p.lengthPrompt,
        kind: 'single',
        options: p.lengthOptions,
        allowFreeText: true,
      };
    },
  },
  {
    id: 'target-platform',
    build({ creativeDomain }) {
      const p = getProfile(creativeDomain);
      return {
        id: 'target-platform',
        prompt: p.platformPrompt,
        kind: 'multi',
        options: p.platformOptions,
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

export function buildGenreQuestion(domain: CreativeDomain = 'generic'): ClarificationQuestion | null {
  const tmpl = templates.find((t) => t.id === 'genre');
  return tmpl?.build({ creativeDomain: domain }) ?? null;
}

/**
 * Infer the creative domain from a user goal. Returns 'generic' when the goal
 * doesn't match any specialized domain so callers still get a reasonable
 * default genre set.
 *
 * Pattern ordering matters — specific compounds first (game before video,
 * music before generic article). The first match wins, so a phrase like
 * "เพลงประกอบเกม" will match `music` (the artifact is a song, not the
 * game). Conversely, "วิดีโอเกม" matches `game` first because it's a
 * single compound noun for the artifact.
 */
export function inferCreativeDomain(goal: string): CreativeDomain {
  const lower = goal.toLowerCase();
  // 1. Game compounds first — "วิดีโอเกม" must NOT match `video`.
  if (/วิดีโอเกม|video[\s-]?game/i.test(lower)) return 'game';
  // 2. Webtoon (specific text format).
  if (/(เว็บตูน|webtoon|การ์ตูน|tapas)/i.test(lower)) return 'webtoon';
  // 3. Novel / short-story (specific long-form text).
  if (/(นิยาย|novel|เรื่องสั้น|เรื่องยาว|short story|literary fiction)/i.test(lower)) return 'novel';
  // 4. Game (after compounds, before broad nouns).
  // Thai pattern uses bare `เกม` / `เกมส์` (the `(?:ส์)?` makes the silent-tone
  // suffix optional as a unit — `?` only quantifies the immediately preceding
  // atom, so `ส์?` would require `ส` and miss bare `เกม`). No \b — JS word
  // boundaries are ASCII-only and don't fire between Thai script and a space.
  if (
    /(เกม(?:ส์)?|\bgame\b|level\s+design|level\s+for\s+a\s+(?:platformer|game)|build\s+a\s+level|character\s+design|\bquest\b|\blore\b|game\s+jam|roguelike|jrpg|rpg|ttrpg|platformer|metroidvania|visual\s+novel|sandbox\s+game)/i.test(
      lower,
    )
  )
    return 'game';
  // 5. Music (specific audio).
  if (
    /(เพลง|แต่งเพลง|ทำเพลง|song|lyric|jingle|melody|hook|verse|chorus|track\b|album|ep\b|soundtrack|score|podcast)/i.test(
      lower,
    )
  )
    return 'music';
  // 6. Marketing / advertising.
  if (
    /(โฆษณา|แคมเปญ|copywrit(ing|er)|tagline|slogan|landing page|\bad\b|\bads\b|campaign|brand awareness|product launch|promotion|email marketing)/i.test(
      lower,
    )
  )
    return 'marketing';
  // 7. Education / course material.
  if (
    /(หลักสูตร|บทเรียน|course\b|courses\b|lesson|curriculum|syllabus|workshop|bootcamp|cohort|tutorial series|mooc)/i.test(
      lower,
    )
  )
    return 'education';
  // 8. Business / strategy doc.
  if (
    /(แผนธุรกิจ|พิทช์[\s-]?เด็ค|พิทช์|เด็คนักลงทุน|business\s+plan|pitch\s+deck|one[\s-]pager|executive\s+summary|proposal|whitepaper|okr\b|kpi\b|investor\s+deck|investor\s+memo|memo\b|strategy\s+brief|market\s+analysis|company\s+overview|series\s+[a-d]\b)/i.test(
      lower,
    )
  )
    return 'business';
  // 9. Visual / design assets.
  if (
    /(โปสเตอร์|poster|infographic|logo|branding|brand identity|illustration|icon set|app icon|wordmark|cover art|banner art|mockup|packaging design)/i.test(
      lower,
    )
  )
    return 'visual';
  // 10. Article / blog (catch-all text).
  if (/(บทความ|article|blog|essay|post|newsletter)/i.test(lower)) return 'article';
  // 11. Video (broad — TikTok/Reels/YT-Short variants).
  if (/(คลิป|วิดีโอ|video|tiktok|reel|reels|shorts?|youtube|vlog|podcast)/i.test(lower)) return 'video';
  return 'generic';
}

// ── Public surface for tests + consumers ───────────────────────────────

/** Exposed so the orchestrator + tests can iterate over registered domains. */
export const CREATIVE_DOMAINS: ReadonlyArray<CreativeDomain> = [
  'webtoon',
  'novel',
  'article',
  'video',
  'music',
  'game',
  'marketing',
  'education',
  'business',
  'visual',
  'generic',
] as const;
