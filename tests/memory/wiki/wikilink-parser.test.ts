/**
 * Wikilink parser — extraction + edge typing.
 */
import { describe, expect, it } from 'bun:test';
import { normalizeTarget, parseWikilinks } from '../../../src/memory/wiki/wikilink-parser.ts';

describe('parseWikilinks', () => {
  it('extracts a bare wikilink as `mentions`', () => {
    const links = parseWikilinks('See [[concept-foo]] for details.');
    expect(links.length).toBe(1);
    expect(links[0]?.target).toBe('concept-foo');
    expect(links[0]?.edgeType).toBe('mentions');
  });

  it('extracts typed prefix wikilinks', () => {
    const links = parseWikilinks('[[supersedes:old-page]] [[cites:src-1]]');
    expect(links.length).toBe(2);
    const types = links.map((l) => l.edgeType).sort();
    expect(types).toEqual(['cites', 'supersedes']);
  });

  it('strips display text and anchors', () => {
    const links = parseWikilinks('[[concept-foo|Foo Display#anchor]]');
    expect(links.length).toBe(1);
    expect(links[0]?.target).toBe('concept-foo');
    expect(links[0]?.display).toBe('Foo Display#anchor');
  });

  it('ignores empty wikilinks', () => {
    expect(parseWikilinks('[[]] [[ ]]').length).toBe(0);
  });

  it('normalizeTarget slugifies free-form text but passes slugs through', () => {
    expect(normalizeTarget('concept-foo')).toBe('concept-foo');
    expect(normalizeTarget('Some Title!')).toBe('some-title');
    expect(normalizeTarget('UPPER')).toBe('upper');
  });
});
