import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeYouTubeUrl, parseYouTubeVideoId } from './youtube';

const ID = 'dQw4w9WgXcQ';

test('parseYouTubeVideoId accepts watch, youtu.be, shorts, embed', () => {
  assert.equal(parseYouTubeVideoId(`https://www.youtube.com/watch?v=${ID}`), ID);
  assert.equal(parseYouTubeVideoId(`https://youtube.com/watch?v=${ID}&t=30`), ID);
  assert.equal(parseYouTubeVideoId(`https://youtu.be/${ID}`), ID);
  assert.equal(parseYouTubeVideoId(`https://youtu.be/${ID}?t=10`), ID);
  assert.equal(parseYouTubeVideoId(`https://www.youtube.com/shorts/${ID}`), ID);
  assert.equal(parseYouTubeVideoId(`https://www.youtube.com/embed/${ID}`), ID);
  assert.equal(parseYouTubeVideoId(`youtube.com/watch?v=${ID}`), ID);
  assert.equal(parseYouTubeVideoId(`m.youtube.com/watch?v=${ID}`), ID);
});

test('parseYouTubeVideoId rejects non-YouTube and bad ids', () => {
  assert.equal(parseYouTubeVideoId('https://vimeo.com/123456'), null);
  assert.equal(parseYouTubeVideoId('https://www.youtube.com/watch?v=short'), null);
  assert.equal(parseYouTubeVideoId('https://www.youtube.com/playlist?list=PLxx'), null);
  assert.equal(parseYouTubeVideoId('https://www.youtube.com/'), null);
  assert.equal(parseYouTubeVideoId(''), null);
  assert.equal(parseYouTubeVideoId('not a url'), null);
});

test('normalizeYouTubeUrl builds canonical watch url', () => {
  assert.equal(normalizeYouTubeUrl(ID), `https://www.youtube.com/watch?v=${ID}`);
});
