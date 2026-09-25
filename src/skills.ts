import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Logger } from "./utils.js";

const MAX_SKILL_DEPTH = 8;
const SKIPPED_DIRECTORIES = new Set([".git", "node_modules", ".worktrees", "dist", "build"]);

export type SkillOrigin = "workspace" | "user" | "cursor";

export interface CustomSkill {
	name: string;
	description: string;
	template: string;
	sourcePath: string;
	origin: SkillOrigin;
}

async function collectSkillFiles(
	dir: string,
	seen: Set<string>,
	warn: (message: string, error: unknown) => void,
	depth = 0,
): Promise<string[]> {
	if (depth > MAX_SKILL_DEPTH) return [];
	let realDir: string;
	try {
		realDir = await fs.realpath(dir);
	} catch (error) {
		if (!isMissing(error)) warn(`Unable to resolve skill directory ${dir}`, error);
		return [];
	}
	if (seen.has(realDir)) return [];
	seen.add(realDir);
	let entries: import("node:fs").Dirent[];
	try {
		entries = await fs.readdir(dir, { withFileTypes: true, encoding: "utf8" });
	} catch (error: unknown) {
		if (!isMissing(error)) warn(`Unable to read skill directory ${dir}`, error);
		return [];
	}

	entries.sort((a, b) => a.name.localeCompare(b.name));

	const classified = await Promise.all(
		entries.map(async (entry) => {
			const fullPath = path.join(dir, entry.name);
			let isDirectory = entry.isDirectory();
			let isFile = entry.isFile();
			if (entry.isSymbolicLink()) {
				try {
					const target = await fs.stat(fullPath);
					isDirectory = target.isDirectory();
					isFile = target.isFile();
				} catch (error) {
					if (!isMissing(error)) warn(`Unable to follow skill link ${fullPath}`, error);
					return null;
				}
			}
			if (isDirectory && SKIPPED_DIRECTORIES.has(entry.name)) {
				try {
					isDirectory = (await fs.stat(path.join(fullPath, "SKILL.md"))).isFile();
				} catch (error) {
					if (!isMissing(error))
						warn(`Unable to inspect skill directory ${fullPath}`, error);
					isDirectory = false;
				}
			}
			return {
				fullPath,
				isDirectory,
				isSkillFile: isFile && entry.name.toLowerCase() === "skill.md",
			};
		}),
	);
	const files: string[] = [];
	for (const item of classified) {
		if (!item?.isSkillFile) continue;
		try {
			const realFile = await fs.realpath(item.fullPath);
			if (!seen.has(realFile)) {
				seen.add(realFile);
				files.push(realFile);
			}
		} catch (error) {
			if (!isMissing(error)) warn(`Unable to resolve skill file ${item.fullPath}`, error);
		}
	}
	// A directory with SKILL.md is one skill; supporting examples inside it are not separate skills.
	if (!classified.some((item) => item?.isSkillFile)) {
		const children = classified
			.filter((item) => item?.isDirectory)
			.map((item) => item!.fullPath);
		for (const child of children) {
			files.push(...(await collectSkillFiles(child, seen, warn, depth + 1)));
		}
	}

	return files;
}

function isMissing(error: unknown): boolean {
	return (
		typeof error === "object" &&
		error !== null &&
		"code" in error &&
		(error as { code?: string }).code === "ENOENT"
	);
}

async function workspaceDirectories(workspace: string): Promise<string[]> {
	const directories = [path.resolve(workspace)];
	let current = directories[0]!;
	while (path.dirname(current) !== current) {
		try {
			await fs.stat(path.join(current, ".git"));
			return directories;
		} catch (error) {
			if (!isMissing(error)) break;
		}
		current = path.dirname(current);
		directories.push(current);
	}
	return [directories[0]!];
}

function parseFrontmatter(markdown: string): {
	metadata: Record<string, string>;
	body: string;
} {
	const lines = markdown.split(/\r?\n/);
	if (lines[0]?.trim() !== "---") {
		return { metadata: {}, body: markdown };
	}

	let end = -1;
	for (let i = 1; i < lines.length; i += 1) {
		if (lines[i]?.trim() === "---") {
			end = i;
			break;
		}
	}

	if (end === -1) {
		return { metadata: {}, body: markdown };
	}

	const metadata: Record<string, string> = {};
	for (const line of lines.slice(1, end)) {
		const delimiter = line.indexOf(":");
		if (delimiter <= 0) {
			continue;
		}
		const key = line.slice(0, delimiter).trim().toLowerCase();
		const value = line.slice(delimiter + 1).trim();
		if (key && value) {
			metadata[key] = value;
		}
	}

	return {
		metadata,
		body: lines.slice(end + 1).join("\n"),
	};
}

function firstHeading(markdown: string): string | undefined {
	const match = markdown.match(/^\s*#\s+(.+)$/m);
	if (!match?.[1]) {
		return undefined;
	}
	const heading = match[1].trim();
	return heading.length > 0 ? heading : undefined;
}

function cleanMetadataValue(value: string | undefined): string | undefined {
	const trimmed = value?.trim();
	if (!trimmed || trimmed === "''" || trimmed === '""') {
		return undefined;
	}
	return trimmed.replace(/^['"](.+)['"]$/, "$1").trim() || undefined;
}

async function readSkill(filePath: string, origin: SkillOrigin): Promise<CustomSkill | null> {
	const raw = await fs.readFile(filePath, "utf8");
	const { metadata, body } = parseFrontmatter(raw);
	const template = body.trim();
	if (!template) {
		return null;
	}

	const heading = firstHeading(body);
	const dirName = path.basename(path.dirname(filePath)).trim();
	const name = cleanMetadataValue(metadata.name) || heading || dirName;
	if (!name) {
		return null;
	}

	const description =
		cleanMetadataValue(metadata.description) ||
		(heading && heading !== name ? heading : undefined) ||
		`Skill from ${dirName || path.basename(filePath)}`;

	return {
		name,
		description,
		template,
		sourcePath: filePath,
		origin,
	};
}

export async function loadCustomSkills(
	workspace: string,
	homeDirectory: string = os.homedir(),
	logger: Pick<Logger, "warn"> = console,
): Promise<CustomSkill[]> {
	const skillRoots: Array<{ root: string; origin: SkillOrigin }> = [
		...(await workspaceDirectories(workspace)).flatMap((directory) => [
			{ root: path.join(directory, ".cursor", "skills"), origin: "workspace" as const },
			{ root: path.join(directory, ".agents", "skills"), origin: "workspace" as const },
		]),
		{ root: path.join(homeDirectory, ".agents", "skills"), origin: "user" },
		{ root: path.join(homeDirectory, ".cursor", "skills"), origin: "user" },
		{
			root: path.join(homeDirectory, ".cursor", "skills-cursor"),
			origin: "cursor",
		},
	];

	const byName = new Map<string, CustomSkill>();
	const seen = new Set<string>();
	const warn = (message: string, error: unknown) =>
		logger.warn?.(`[cursor-acp] ${message}`, error);
	for (const { root, origin } of skillRoots) {
		const files = await collectSkillFiles(root, seen, warn);
		for (const file of files) {
			let skill: CustomSkill | null;
			try {
				skill = await readSkill(file, origin);
			} catch (error) {
				if (!isMissing(error)) warn(`Unable to read skill file ${file}`, error);
				continue;
			}
			if (!skill) {
				continue;
			}
			const key = skill.name.toLowerCase();
			if (!byName.has(key)) {
				byName.set(key, skill);
			}
		}
	}

	return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export function resolveSkillPrompt(
	commandName: string,
	args: string,
	skills: CustomSkill[],
): string | null {
	const normalized = commandName.toLowerCase();
	const stripped = normalized.startsWith("skill:")
		? normalized.slice("skill:".length)
		: normalized.startsWith("skills:")
			? normalized.slice("skills:".length)
			: normalized.startsWith("skills/")
				? normalized.slice("skills/".length)
				: normalized;
	const match = skills.find((skill) => skill.name.toLowerCase() === stripped);
	if (!match) return null;
	const prompt = `Skill file: ${match.sourcePath}\nSkill directory: ${path.dirname(match.sourcePath)}\n\n${match.template}`;
	return args.trim() ? `${prompt}\n\n${args.trim()}` : prompt;
}
