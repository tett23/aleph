// The prompt of the local connector (docs/adr/0086): the fixed instruction and
// the material in the system message (docs/adr/0081), the worked examples for
// the target's kind and the one of a command as earlier turns of the chat, then
// the writer's request and the target in the last user message.

export type Command = { id: string; label: string };
export type Message = { role: "system" | "user" | "assistant"; content: string };

export const INTRO = `あなたは、原稿のエディタ Aleph のアシスタントです。
書き手の頼みと対象のテキストを受け、書き換えの案と短い説明を JSON で返します。`;

// how to tell a question about a command from a request to rewrite
export const COMMAND_RULE = `まず、頼みが次のどちらかを決めます。

- 下の資料の「Aleph のコマンド」に、頼みをそのまま行うコマンドがあるとき (画面を出す、組む、変換する、保存する、捨てる、並べる、記録する、作る、開くなど) は、テキストを書き換えません。edits を空にし、explanation に、そのコマンドの ID と名前を一覧に書かれたとおりに書きます。
- そうでないときは、対象のテキストを書き換えます。`;

export const REWRITE_RULES = `書き換えるときは、次の決まりに従います。

- 書き換えは edits に、対象のテキストの一部 find と、それを置き換える文字列 replace の組で書きます。
- find は、対象のテキストに書かれたとおりの文字列で、対象の中にちょうど一度だけ現れるものにします。一度だけにならないときは、前後の文字や行を含めます。
- 二つの find の範囲を重ねません。
- 文字を足すときは、足す位置のそばの一度だけ現れる文字列を find にし、replace にその文字列と足す文字列を書きます。
- 消すときは、replace を空にします。
- 頼みが「」で示した語に記号を付けるときは、その語だけを囲みます。前後の字を含めません。
- 頼みが求めたこと以外は変えません。
- Golem の原稿 (.gm)、style.toml、manifest.toml の書き方は、下の資料の Golem のマニュアルに従います。

explanation には、何をしたかを日本語で一文か二文で書きます。`;

export const INSTRUCTION = [INTRO, COMMAND_RULE, REWRITE_RULES].join("\n\n");

export type Example = { request: string; file: string; target: string; answer: { explanation: string; edits: { find: string; replace: string }[] } };

// Worked examples: one for each of style.toml, manifest.toml, .gm and .md, and
// one of a command. None of them is a task of the benchmark
// (bench/assistant/lib/set.test.ts checks it, ADR 0086 I2).
export const EXAMPLES: readonly Example[] = [
  {
    request: "段組みを 2 段にして",
    file: "style.toml",
    target: '[page.grid]\ncharacters = 40\nlines = 17\ncolumns = 1\n',
    answer: { explanation: "段数を 1 段から 2 段にします。", edits: [{ find: "columns = 1", replace: "columns = 2" }] },
  },
  {
    request: "2 章と 3 章の順番を入れ替えて",
    file: "manifest.toml",
    target: 'chapters = ["chapters/01.gm", "chapters/02.gm", "chapters/03.gm"]\n\n[metadata]\ntitle = "海辺"\n',
    answer: {
      explanation: "chapters の 2 番目と 3 番目を入れ替えます。",
      edits: [{ find: '"chapters/02.gm", "chapters/03.gm"', replace: '"chapters/03.gm", "chapters/02.gm"' }],
    },
  },
  {
    request: "「静か」に圏点を打って",
    file: "chapters/03.gm",
    target: "# 夜\n\n静かな夜だった。\n",
    answer: { explanation: "「静か」だけを圏点で囲みます。「な」は含めません。", edits: [{ find: "静かな夜", replace: "[kenten: 静か]な夜" }] },
  },
  {
    request: "箇条書きの * の後に空白が無いので直して",
    file: "notes.md",
    target: "買うもの\n\n*りんご\n",
    answer: { explanation: "* の後に空白を足します。", edits: [{ find: "*りんご", replace: "* りんご" }] },
  },
  {
    request: "アプリの設定を変えたい",
    file: "chapters/03.gm",
    target: "# 夜\n\n本文。\n",
    answer: { explanation: "コマンド「設定」(settings.open) を使います。", edits: [] },
  },
];

export const commandList = (commands: readonly Command[]) => ["## Aleph のコマンド (ID: 名前)", ...commands.map((c) => `- ${c.id}: ${c.label}`)].join("\n");

export const userMessage = (request: string, file: string, target: string) =>
  `頼み: ${request}\n対象のファイル: ${file}\n対象のテキスト (<target> と </target> のあいだ):\n<target>\n${target}</target>`;

// The kind of a file: style.toml and manifest.toml by name, any other file by
// its extension ("" when it has none), all in lower case
export const fileKind = (path: string) => {
  const name = path.slice(path.lastIndexOf("/") + 1).toLowerCase();
  if (name === "style.toml" || name === "manifest.toml") return name;
  const dot = name.lastIndexOf(".");
  return dot < 0 ? "" : name.slice(dot);
};

export const isCommandExample = (e: Example) => e.answer.edits.length === 0;

// The examples of the target's kind (if any), then the one of a command (I1)
export const examplesFor = (file: string): Example[] => [
  ...EXAMPLES.filter((e) => !isCommandExample(e) && fileKind(e.file) === fileKind(file)),
  ...EXAMPLES.filter(isCommandExample),
];

// Each example as the request of a user message and its answer
export const exampleTurns = (examples: readonly Example[], answer: (e: Example) => string = (e) => JSON.stringify(e.answer)): Message[] =>
  examples.flatMap((e) => [
    { role: "user" as const, content: userMessage(e.request, e.file, e.target) },
    { role: "assistant" as const, content: answer(e) },
  ]);

export const withMaterial = (head: string, material: string) => (material === "" ? head : `${head}\n\n# 資料\n\n${material}`);

// The system message, the examples' turns, then the request (I3)
export const messages = (material: string, request: string, file: string, target: string, examples: readonly Example[] = examplesFor(file)): Message[] => [
  { role: "system", content: withMaterial(INSTRUCTION, material) },
  ...exampleTurns(examples),
  { role: "user", content: userMessage(request, file, target) },
];

// The fixed part (I4): the tokens of the messages built with the material left
// empty, rendered with the chat template. The material limit is
// materialLimit(context, fixed) of material.ts.
export const fixedTokens = async (
  build: (material: string) => Message[],
  render: (ms: Message[]) => string | Promise<string>,
  count: (text: string) => number | Promise<number>,
): Promise<number> => count(await render(build("")));
