# 代码风格规则

本项目的规则由两层组成：

- **ESLint** 负责语义和语法约束，以及 Prettier 无法表达的格式要求。
- **Prettier** 负责缩进、换行、引号、分号等普通排版。

## 命令

```bash
npm install           # 安装 ESLint / Prettier 依赖，并更新 package-lock.json
npm run lint          # 只检查
npm run lint:fix      # 自动修复可修复项
npm run format        # 按 Prettier 规则重写代码
npm run format:check  # 检查 Prettier 格式
npm run style-check   # lint + format:check
```

> 规则确认阶段不批量迁移源码；本次只把 `Service` 示例所在文件按新规则格式化。第一次运行 `npm run lint` 时，其余历史文件仍会看到大量报错，这是预期行为；应先完成规则确认，再单独提交格式化迁移。

## 规则对照

| # | 要求 | 实现 |
| --- | --- | --- |
| 1 | 变量声明必须显式标注类型 | `local/require-variable-type`：检查每个 `VariableDeclarator`，包括解构和 `for...of`；例如 `let studentAge: number = 6;` |
| 2 | 禁止 `function` 关键字 | `local/no-function-keyword`：禁止函数声明、函数表达式和 `declare function`；类/对象方法没有关键字，不会误报 |
| 3 | 语句必须以分号结尾 | `@stylistic/semi` + `@stylistic/no-extra-semi`，同时 Prettier `semi: true` |
| 4 | 参数之间禁止换行 | `local/no-multiline-parameters`：检查相邻形参之间的源码是否含换行 |
| 5 | 缩进 4 空格 | Prettier `tabWidth: 4`、`useTabs: false`；ESLint 不启用 `indent`，避免两套缩进算法冲突 |
| 6 | 优先双引号，必要时单引号；拼接/转字符串用模板字符串 | `@stylistic/quotes`（`double` + `avoidEscape`）、`prefer-template`、`local/prefer-template-for-string-conversion` |
| 7 | 禁止 `== undefined` / `=== undefined`，使用 `=== (void 0)` | `local/no-undefined-comparison`：报告 `undefined`、缺少括号的 `void 0`，并自动改成严格比较；括号由 Prettier 专用 printer 保留 |
| 8 | 使用 `typeof(variable)` | `local/require-typeof-parentheses`：自动补括号；Prettier 专用 printer 会输出 `typeof(...)`，不会还原成 `typeof ...` |
| 9 | 箭头函数和 interface 属性末尾分号 | `@stylistic/semi`、`@stylistic/member-delimiter-style`，Prettier `semi: true` |
| 10 | 变量名小写开头驼峰 | `local/variable-naming`：局部变量、形参、catch 参数使用 `lowerCamelCase` |
| 11 | 全局对象大写开头驼峰 | `local/variable-naming`：模块顶层的非函数变量使用 `PascalCase` |
| 12 | 所有注释必须是多行 JSDoc | `local/jsdoc-comment-format`：拒绝 `//` 和普通 `/* ... */`；要求 `/**`、描述行、`*/` 分行。工具指令（`eslint-*`、`@ts-*`、`prettier-*`、`c8`、`istanbul`、`v8`、source-map、shebang）通过 `allowPatterns` 豁免 |
| 13 | 控制语句不得省略大括号 | ESLint `curly: ["error", "all"]`：`if` / `else` / `for` / `while` / `do` 等必须使用块；Prettier 负责块内排版 |
| 14 | 类型参数之间禁止换行 | `local/no-multiline-type-parameters`：检查相邻类型参数之间的源码是否含换行；`amp-typescript` printer 会把整组类型参数压成一行 |

## 命名规则的范围

第 11 条中的“全局对象”按**模块顶层的数据变量**处理：

```ts
const GlobalAge: number = 154; // 顶层数据变量：PascalCase
const parseManifest = (input: string): Manifest => { /* ... */ }; // 顶层函数值：lowerCamelCase

const readAge = (): number => {
    const studentAge: number = 6; // 局部变量：lowerCamelCase
    return studentAge;
};
```

顶层的箭头函数值仍使用 `lowerCamelCase`，因为它是函数而不是全局数据对象；局部变量和参数始终使用 `lowerCamelCase`。

## 配置本身也是 TypeScript

- ESLint 配置：[`eslint.config.mts`](eslint.config.mts)
- Prettier 配置：[`prettier.config.mts`](prettier.config.mts)
- 本地 ESLint 规则：[`tools/eslint-rules/`](tools/eslint-rules/)
- 本地 Prettier printer：[`tools/prettier-plugin/index.mts`](tools/prettier-plugin/index.mts)

ESLint 的 TypeScript 配置通过 `jiti` 加载；Prettier 的 `.mts` 配置依赖 Node.js 的类型剥离支持。`jiti`、`prettier` 和类型定义依赖已写入 [`package.json`](package.json)。

> 当前目录里还留有上一版生成的 `.js` / `.mjs` 文件和两个一行转发 shim。文件工具在当前会话中无法删除文件；确认新配置可用后请执行 `npm run cleanup:style`（见文末），否则 ESLint/Prettier 会优先加载 shim。

## 两个格式细节

### 参数不换行与 `printWidth`

Prettier 没有“禁止参数/类型参数换行”的配置项，本项目用两种办法实现：

- 普通形参：把 `printWidth` 设为 160，让常规签名保持单行；如果签名超过 160 列，Prettier 仍会折行，此时第 4 条 ESLint 规则会报错。请缩短签名，不要用格式化器关闭该规则。
- 类型参数：自定义 printer 把整组类型参数渲染成一行，不受 `printWidth` 限制。`export abstract class Service<TEntity extends object, TKey extends PrimaryKey = PrimaryKey, TRepository extends Repository<TEntity, TKey> = Repository<TEntity, TKey>>` 即便超过 160 列也保持单行（第 14 条）。

### 为什么需要自定义 Prettier printer

[`prettier.config.mts`](prettier.config.mts) 加载 [`tools/prettier-plugin/index.mts`](tools/prettier-plugin/index.mts)，注册 `amp-typescript` parser。它只改三类输出：

```ts
typeof(value)       // 而不是 typeof value
value === (void 0)  // 而不是 value === void 0
class Service<TEntity extends object, TKey extends PrimaryKey>  // 而不是每个类型参数一行
```

否则 Prettier 会删除这些“多余”的括号，或把类型参数逐个折行，使 ESLint 自动修复/检查的结果在下次格式化时失效。

类型参数列表如果含注释，printer 会退回 Prettier 默认换行，`local/no-multiline-type-parameters` 也会同步跳过，避免格式化和检查互相打架。

## VS Code

工作区已创建 [`.vscode/settings.json`](.vscode/settings.json)（该文件被 `.gitignore` 忽略，仅对本机生效），把 Prettier 设为 TypeScript / JavaScript 的默认格式化器，并开启 `prettier.requireConfig`。按 `Shift+Alt+F`（或右键 “Format Document”）即可用 Prettier 格式化。

如果刚修改过 `prettier.config.mts` 或 `tools/prettier-plugin/index.mts`，请执行一次 “Developer: Reload Window”：Prettier 扩展会缓存配置和 printer 模块，仅重新加载配置不会重新导入已修改的插件。

保存时自动格式化已开启（`editor.formatOnSave: true`）；保存历史文件时会按 Prettier 规则重排整个文件，这是预期行为。

## 清理旧 JavaScript 配置文件

当前目录里还留有上一版生成的 `.js` / `.mjs` 文件。文件工具在当前会话中无法删除文件，因此先用两个一行 shim 保证 ESLint/Prettier 仍能工作。确认新配置可用后执行：

```bash
npm run cleanup:style
```

或直接：

```bash
node tools/cleanup-style-configs.ts
```

该脚本会删除旧的根配置、旧规则文件和旧 printer。删除后，ESLint 会直接加载 `eslint.config.mts`，Prettier 会直接加载 `prettier.config.mts`。

## 不适用 / 已知边界

- 第 7 条只覆盖与 `undefined` 直接比较的相等运算；`x == null` 等其他宽松比较不在范围内。
- 第 6 条的 `String(value)` / `value.toString()` 自动修复是风格转换，不分析类型；`String(Symbol())` 与模板字符串的行为不同，遇到符号时应确认语义。
- 不带括号的 `typeof` 类型查询（TypeScript 的 `typeof Foo` 类型位置）不是运行时 `typeof` 运算，不适用第 8 条。
- 第 14 条只检查类型参数声明（`class` / `interface` / `type` / `function` 的 `<...>`），不检查使用处的类型实参（`Foo<T, U>`）；声明内嵌套的类型实参会随整组一起压平。含注释的类型参数列表会跳过检查，保持 Prettier 默认换行。
- 第 14 条刻意让超长泛型声明超过 `printWidth`（`Service` 示例为 168 列），不要再启用 `max-len` 一类规则与之冲突。
- `.d.ts` 中的 `declare function` 也会触发第 2 条；如确需声明文件，请改用函数类型别名或单独为该文件添加豁免。
