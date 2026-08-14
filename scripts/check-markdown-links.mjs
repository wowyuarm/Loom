import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import GithubSlugger from "github-slugger";
import { marked } from "marked";

const repositoryRoot = execFileSync("git", ["rev-parse", "--show-toplevel"], {
  encoding: "utf8",
}).trim();
const checkedRoots = [
  "AGENTS.md",
  "README.md",
  "CONTEXT.md",
  "docs",
  ".scratch/README.md",
  ".scratch/codebase/README.md",
];
const markdownFiles = checkedRoots.flatMap(collectMarkdownFiles).sort();

const documents = new Map();
const failures = [];

for (const relativeFile of markdownFiles) {
  const document = readDocument(relativeFile);
  for (const href of document.links) validateLink(relativeFile, href);
}

if (failures.length > 0) {
  for (const failure of failures) console.error(failure);
  process.exitCode = 1;
} else {
  console.log(`Checked ${markdownFiles.length} Markdown files.`);
}

function readDocument(relativeFile) {
  const cached = documents.get(relativeFile);
  if (cached) return cached;

  const source = readFileSync(path.join(repositoryRoot, relativeFile), "utf8");
  const tokens = marked.lexer(source);
  const links = [];
  const anchors = new Set();
  const slugger = new GithubSlugger();

  marked.walkTokens(tokens, token => {
    if (token.type === "heading") {
      anchors.add(slugger.slug(plainText(token.tokens ?? [])));
    } else if (token.type === "link" || token.type === "image") {
      links.push(token.href);
    } else if (token.type === "html") {
      for (const match of token.raw.matchAll(/\b(?:id|name)=["']([^"']+)["']/gi)) {
        anchors.add(match[1]);
      }
    }
  });

  const document = { anchors, links };
  documents.set(relativeFile, document);
  return document;
}

function collectMarkdownFiles(relativePath) {
  const absolutePath = path.join(repositoryRoot, relativePath);
  if (!existsSync(absolutePath)) return [];
  if (!lstatSync(absolutePath).isDirectory()) return relativePath.endsWith(".md") ? [relativePath] : [];
  return readdirSync(absolutePath, { withFileTypes: true }).flatMap(entry => {
    const child = path.join(relativePath, entry.name);
    return entry.isDirectory() ? collectMarkdownFiles(child) : child.endsWith(".md") ? [child] : [];
  });
}

function plainText(tokens) {
  return tokens.map(token => {
    if ("tokens" in token && Array.isArray(token.tokens)) return plainText(token.tokens);
    if ("text" in token && typeof token.text === "string") return token.text;
    return "";
  }).join("");
}

function validateLink(sourceFile, href) {
  if (!href || href.startsWith("/") || href.startsWith("//") || /^[a-z][a-z+.-]*:/i.test(href)) return;

  const hashIndex = href.indexOf("#");
  const rawPath = (hashIndex === -1 ? href : href.slice(0, hashIndex)).split("?", 1)[0];
  const rawAnchor = hashIndex === -1 ? "" : href.slice(hashIndex + 1);
  let decodedPath;
  let decodedAnchor;
  try {
    decodedPath = decodeURIComponent(rawPath);
    decodedAnchor = decodeURIComponent(rawAnchor);
  } catch {
    failures.push(`${sourceFile}: invalid percent-encoding in link ${JSON.stringify(href)}`);
    return;
  }

  const targetPath = path.resolve(repositoryRoot, path.dirname(sourceFile), decodedPath || ".");
  const relativeTarget = path.relative(repositoryRoot, targetPath);
  if (relativeTarget.startsWith("..") || path.isAbsolute(relativeTarget)) {
    failures.push(`${sourceFile}: link leaves the repository: ${JSON.stringify(href)}`);
    return;
  }
  if (!existsSync(targetPath)) {
    failures.push(`${sourceFile}: missing target ${JSON.stringify(href)}`);
    return;
  }
  if (!decodedAnchor) return;

  let anchorFile = decodedPath ? relativeTarget : sourceFile;
  if (decodedPath && lstatSync(targetPath).isDirectory()) anchorFile = path.join(relativeTarget, "README.md");
  if (path.extname(anchorFile).toLowerCase() !== ".md") return;
  if (!existsSync(path.join(repositoryRoot, anchorFile))) {
    failures.push(`${sourceFile}: target has no Markdown index for ${JSON.stringify(href)}`);
    return;
  }
  if (!readDocument(anchorFile).anchors.has(decodedAnchor)) {
    failures.push(`${sourceFile}: missing heading #${decodedAnchor} in ${anchorFile}`);
  }
}
