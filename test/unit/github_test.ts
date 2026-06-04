// ===========================================================================
// TEST: GitHub URL parsing + REST/raw access for the F5_GitHub enricher.
// CATEGORY: unit
// COVERS: lib/http/github.ts (fns: parseGithubUrl, githubApi)
//   + lib/enrich/enrichers.ts (enrichGithub README base64 / empty-body paths)
// FIXTURES: github/{issue,pull,pull_empty,readme}.json
// NETWORK: none (mocked FetchFn)
// ASSERTS:
//   - parseGithubUrl classifies issue / pull / blob(file) / readme / unsupported
//   - githubApi returns parsed JSON (issue body, pull body)
//   - an empty PR body -> benign bodyError (no throw) via enrichGithub
//   - a README is base64-decoded into the body
// ===========================================================================

import { assertEquals, assertStringIncludes, assertThrows } from "@std/assert";
import { githubApi, parseGithubUrl } from "../../lib/http/github.ts";
import { enrichGithub } from "../../lib/enrich/enrichers.ts";
import { HttpClient } from "../../lib/http/fetcher.ts";
import { loadFixture } from "../_helpers/fixtures.ts";
import { makeMockFetch } from "../_helpers/mock_fetch.ts";

Deno.test("parseGithubUrl: issue", () => {
  const t = parseGithubUrl("https://github.com/F5Networks/repo/issues/42");
  assertEquals(t.kind, "issue");
  assertEquals(t.apiPath, "/repos/F5Networks/repo/issues/42");
});

Deno.test("parseGithubUrl: pull", () => {
  const t = parseGithubUrl("https://github.com/F5Networks/repo/pull/7");
  assertEquals(t.kind, "pull");
  assertEquals(t.apiPath, "/repos/F5Networks/repo/pulls/7");
});

Deno.test("parseGithubUrl: blob -> raw file URL", () => {
  const t = parseGithubUrl("https://github.com/o/r/blob/main/docs/readme.md");
  assertEquals(t.kind, "file");
  assertEquals(t.rawUrl, "https://raw.githubusercontent.com/o/r/main/docs/readme.md");
});

Deno.test("parseGithubUrl: bare repo -> readme", () => {
  const t = parseGithubUrl("https://github.com/o/r");
  assertEquals(t.kind, "readme");
  assertEquals(t.apiPath, "/repos/o/r/readme");
});

Deno.test("parseGithubUrl: unsupported shape throws", () => {
  assertThrows(() => parseGithubUrl("https://github.com/o/r/tree/main"), Error, "unsupported");
  assertThrows(() => parseGithubUrl("https://github.com/o"), Error, "unrecognized");
});

Deno.test("githubApi: returns parsed issue JSON (with body)", async () => {
  const mock = makeMockFetch({ urlMap: { "api.github.com": loadFixture("github/issue.json") } });
  const http = new HttpClient({ fetch: mock.fetch });
  const data = await githubApi("/repos/o/r/issues/1", undefined, http);
  assertStringIncludes(data.body as string, "### Environment");
});

Deno.test("enrichGithub: issue body becomes the section body", async () => {
  const mock = makeMockFetch({ urlMap: { "api.github.com": loadFixture("github/issue.json") } });
  const http = new HttpClient({ fetch: mock.fetch });
  const out = await enrichGithub(
    { id: "x", documentType: "F5_GitHub", link: "https://github.com/o/r/issues/1" },
    "NOW",
    { http },
  );
  assertStringIncludes(out.body_text ?? "", "### Environment");
  assertEquals(Object.keys(out.sections ?? {}), ["issue"]);
});

Deno.test("enrichGithub: empty PR body -> benign bodyError, no throw", async () => {
  const mock = makeMockFetch({
    urlMap: { "api.github.com": loadFixture("github/pull_empty.json") },
  });
  const http = new HttpClient({ fetch: mock.fetch });
  const out = await enrichGithub(
    { id: "x", documentType: "F5_GitHub", link: "https://github.com/o/r/pull/9" },
    "NOW",
    { http },
  );
  assertEquals(out.body_text, undefined);
  assertStringIncludes(out.bodyError ?? "", "empty GitHub pull body");
});

Deno.test("enrichGithub: README base64 decoded", async () => {
  const mock = makeMockFetch({ urlMap: { "api.github.com": loadFixture("github/readme.json") } });
  const http = new HttpClient({ fetch: mock.fetch });
  const out = await enrichGithub(
    { id: "x", documentType: "F5_GitHub", link: "https://github.com/o/r" },
    "NOW",
    { http },
  );
  assertStringIncludes(out.body_text ?? "", "# F5 BIG-IP Imperative Collection for Ansible");
  assertEquals(Object.keys(out.sections ?? {}), ["readme"]);
});
