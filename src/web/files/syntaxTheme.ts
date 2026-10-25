import type { ThemeRegistration } from "shiki/core";

/**
 * Syntax colors from the brand palette, lightened so each one reads at
 * 4.5:1 or more on the code, added and deleted line backgrounds. Green and
 * red mean added and deleted, so every hue stays at least 25° from the
 * add/del inks (both checked by src/web/theme.test.ts): keywords are orchid,
 * not pink.
 */
export const SYNTAX = {
	text: "#e6e3f2",
	comment: "#9497bd",
	keyword: "#d69cff",
	string: "#ffd479",
	number: "#ffa466",
	func: "#5cd3f5",
	type: "#9fb4ff",
	property: "#cdd3f5",
	punctuation: "#b3b5d6",
	invalid: "#ffb454",
} as const;

const c = SYNTAX;

export const syntaxTheme: ThemeRegistration = {
	name: "carbonless-dark",
	type: "dark",
	colors: {
		"editor.foreground": c.text,
		// Unused (the diff paints its own backgrounds); --color-code in index.css.
		"editor.background": "#0e1019",
	},
	settings: [
		{ settings: { foreground: c.text } },
		{
			scope: ["comment", "punctuation.definition.comment", "string.comment"],
			settings: { foreground: c.comment, fontStyle: "italic" },
		},
		{
			scope: [
				"keyword",
				"storage",
				"storage.type",
				"storage.modifier",
				"keyword.control",
				"keyword.operator.new",
				"keyword.operator.expression",
				"keyword.operator.logical.python",
				"entity.name.tag",
				"punctuation.definition.tag",
				"markup.heading punctuation.definition.heading",
			],
			settings: { foreground: c.keyword },
		},
		{
			scope: [
				"string",
				"string.quoted",
				"string.template",
				"string.regexp",
				"punctuation.definition.string",
				"markup.inline.raw",
				"markup.fenced_code",
			],
			settings: { foreground: c.string },
		},
		{
			scope: [
				"constant",
				"constant.numeric",
				"constant.language",
				"constant.character",
				"constant.character.escape",
				"variable.other.constant",
				"entity.other.attribute-name",
				"support.constant",
			],
			settings: { foreground: c.number },
		},
		{
			scope: [
				"entity.name.function",
				"support.function",
				"meta.function-call entity.name.function",
				"variable.function",
				"markup.underline.link",
			],
			settings: { foreground: c.func },
		},
		{
			scope: [
				"entity.name.type",
				"entity.name.class",
				"entity.name.namespace",
				"entity.other.inherited-class",
				"support.type",
				"support.class",
				"storage.type.primitive",
				"markup.heading",
				"entity.name.section",
			],
			settings: { foreground: c.type },
		},
		{
			scope: [
				"variable.other.property",
				"variable.other.object.property",
				"support.type.property-name",
				"meta.object-literal.key",
				"entity.name.tag.yaml",
				"support.type.property-name.json",
			],
			settings: { foreground: c.property },
		},
		{
			scope: [
				"punctuation",
				"keyword.operator",
				"meta.brace",
				"punctuation.separator",
				"punctuation.terminator",
			],
			settings: { foreground: c.punctuation },
		},
		{ scope: ["markup.bold"], settings: { fontStyle: "bold" } },
		{ scope: ["markup.italic"], settings: { fontStyle: "italic" } },
		{ scope: ["invalid"], settings: { foreground: c.invalid } },
	],
};
