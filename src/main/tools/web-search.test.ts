import test from 'node:test'
import assert from 'node:assert/strict'
import { normalizeSearchOptions, parseBaiduResults, parseBingResults } from './web-search'

void test('normalizeSearchOptions clamps limits and trims query', () => {
  assert.deepEqual(
    normalizeSearchOptions({ query: '  TypeScript handbook  ', limit: 99, timeoutMs: 1 }),
    {
      query: 'TypeScript handbook',
      limit: 8,
      timeoutMs: 3_000
    }
  )
})

void test('parseBingResults extracts public titles and urls', () => {
  const html = `
    <ol id="b_results">
      <li class="b_algo">
        <h2><a href="https://www.typescriptlang.org/">TypeScript Official</a></h2>
        <p class="b_lineclamp2">Typed JavaScript at any scale.</p>
      </li>
      <li class="b_algo">
        <h2><a href="https://cn.bing.com/search?q=noise">Noise</a></h2>
        <p>Should be filtered</p>
      </li>
      <li class="b_algo">
        <h2><a href="https://www.ruanyifeng.com/blog/2023/08/typescript-tutorial.html">TS Tutorial</a></h2>
        <div class="b_caption"><p>A Chinese TypeScript tutorial.</p></div>
      </li>
    </ol>
  `
  assert.deepEqual(parseBingResults(html, 5), [
    {
      title: 'TypeScript Official',
      url: 'https://www.typescriptlang.org/',
      snippet: 'Typed JavaScript at any scale.'
    },
    {
      title: 'TS Tutorial',
      url: 'https://www.ruanyifeng.com/blog/2023/08/typescript-tutorial.html',
      snippet: 'A Chinese TypeScript tutorial.'
    }
  ])
})

void test('parseBaiduResults prefers mu absolute urls and filters junk', () => {
  const html = `
    <div class="result c-container" mu="https://developer.baidu.com/article/details/2720893">
      <h3 class="t"><a href="https://www.baidu.com/link?url=abc">TypeScript Handbook 中文</a></h3>
      <span class="c-abstract">百度开发者中心文章摘要</span>
    </div>
    <div class="result c-container" mu="http://28616.recommend_list.baidu.com">
      <h3 class="t"><a href="https://www.baidu.com/link?url=ads">广告</a></h3>
    </div>
    <div class="result c-container" mu="https://github.com/ccnnde/typescript-handbook">
      <h3><a href="https://www.baidu.com/link?url=gh">GitHub handbook</a></h3>
      <div class="c-abstract">GitHub 上的 TypeScript 手册</div>
    </div>
  `
  assert.deepEqual(parseBaiduResults(html, 5), [
    {
      title: 'TypeScript Handbook 中文',
      url: 'https://developer.baidu.com/article/details/2720893',
      snippet: '百度开发者中心文章摘要'
    },
    {
      title: 'GitHub handbook',
      url: 'https://github.com/ccnnde/typescript-handbook',
      snippet: 'GitHub 上的 TypeScript 手册'
    }
  ])
})
