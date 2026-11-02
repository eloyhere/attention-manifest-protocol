/** Explicitly loaded environment descriptions, never local installation probes. */
import type { HostCatalog } from "../discover/host.ts";
import type { HostComponent } from "../discover/types.ts";
import type { EnvironmentMetadata } from "./types.ts";

export interface EnvironmentEntry extends HostComponent, EnvironmentMetadata {
    kind: "module";
    category: EnvironmentMetadata["category"];
    availability: EnvironmentMetadata["availability"];
}

type EnvironmentDefinition = Omit<EnvironmentEntry, "kind" | "availability">;

const DefaultEnvironments: readonly EnvironmentDefinition[] = [
    {
        id: "runtime.powershell7", name: "PowerShell 7", category: "runtime",
        description: "PowerShell major version 7 command and scripting environment; no installed version is inferred.",
        platforms: ["windows", "linux", "darwin"], extensions: [".ps1", ".psm1", ".psd1"], relatedIds: ["runtime.powershell5"],
    },
    {
        id: "runtime.powershell5", name: "Windows PowerShell 5.1", category: "runtime", version: "5.1",
        description: "Windows PowerShell 5.1 command and scripting environment.",
        platforms: ["windows"], extensions: [".ps1", ".psm1", ".psd1"], relatedIds: ["runtime.powershell7"],
    },
    {
        id: "runtime.sh", name: "POSIX sh", category: "runtime",
        description: "POSIX shell command and scripting environment.",
        platforms: ["linux", "darwin", "freebsd"], extensions: [".sh"], relatedIds: ["runtime.bash", "runtime.zsh"],
    },
    {
        id: "runtime.bash", name: "Bash", category: "runtime",
        description: "Bash command and scripting environment.",
        platforms: ["linux", "darwin", "windows", "freebsd"], extensions: [".sh", ".bash"], relatedIds: ["runtime.sh"],
    },
    {
        id: "runtime.zsh", name: "Zsh", category: "runtime",
        description: "Zsh command and scripting environment.",
        platforms: ["linux", "darwin", "freebsd"], extensions: [".sh", ".zsh"], relatedIds: ["runtime.sh"],
    },
    {
        id: "application.word", name: "Microsoft Word", category: "application",
        description: "Word document authoring application environment.",
        platforms: ["windows", "darwin"], extensions: [".docx", ".doc", ".dotx", ".docm"],
    },
    {
        id: "application.excel", name: "Microsoft Excel", category: "application",
        description: "Excel spreadsheet application environment.",
        platforms: ["windows", "darwin"], extensions: [".xlsx", ".xls", ".xlsm", ".xlsb", ".xltx"],
    },
    {
        id: "application.powerpoint", name: "Microsoft PowerPoint", category: "application",
        description: "PowerPoint presentation application environment.",
        platforms: ["windows", "darwin"], extensions: [".pptx", ".ppt", ".pptm", ".potx"],
    },
    {
        id: "application.publisher", name: "Microsoft Publisher", category: "application",
        description: "Publisher page layout application environment.",
        platforms: ["windows"], extensions: [".pub"],
    },
    {
        id: "application.access", name: "Microsoft Access", category: "application",
        description: "Access database application environment.",
        platforms: ["windows"], extensions: [".accdb", ".mdb"],
    },
    {
        id: "application.project", name: "Microsoft Project", category: "application",
        description: "Project scheduling application environment.",
        platforms: ["windows"], extensions: [".mpp", ".mpt"],
    },
    {
        id: "language.c", name: "C", category: "language",
        description: "C programming language environment.", extensions: [".c", ".h"], relatedIds: ["projectType.cmake"],
    },
    {
        id: "language.cpp", name: "C++", category: "language",
        description: "C++ programming language environment.", extensions: [".cpp", ".cc", ".cxx", ".hpp", ".hh", ".hxx", ".h"], relatedIds: ["projectType.cmake"],
    },
    {
        id: "language.java", name: "Java", category: "language",
        description: "Java programming language environment.", extensions: [".java"], relatedIds: ["projectType.maven", "projectType.gradle"],
    },
    {
        id: "language.python", name: "Python", category: "language",
        description: "Python programming language environment.", extensions: [".py", ".pyi", ".pyw"], relatedIds: ["projectType.python"],
    },
    {
        id: "language.javascript", name: "JavaScript", category: "language",
        description: "JavaScript programming language environment.", extensions: [".js", ".mjs", ".cjs", ".jsx"], relatedIds: ["projectType.npm", "language.typescript"],
    },
    {
        id: "language.typescript", name: "TypeScript", category: "language",
        description: "TypeScript programming language environment.", extensions: [".ts", ".mts", ".cts", ".tsx"], relatedIds: ["projectType.npm", "language.javascript"],
    },
    {
        id: "language.csharp", name: "C#", category: "language",
        description: "C# programming language environment.", extensions: [".cs", ".csx"], relatedIds: ["projectType.dotnet"],
    },
    {
        id: "language.go", name: "Go", category: "language",
        description: "Go programming language environment.", extensions: [".go"], relatedIds: ["projectType.go"],
    },
    {
        id: "language.rust", name: "Rust", category: "language",
        description: "Rust programming language environment.", extensions: [".rs"], relatedIds: ["projectType.cargo"],
    },
    {
        id: "projectType.npm", name: "npm project", category: "projectType",
        description: "JavaScript or TypeScript project described by package.json and the npm package ecosystem.",
        extensions: [".json"], relatedIds: ["language.javascript", "language.typescript"],
    },
    {
        id: "projectType.maven", name: "Maven project", category: "projectType",
        description: "Project built and managed with Maven using a pom.xml descriptor.",
        extensions: [".xml"], relatedIds: ["language.java"],
    },
    {
        id: "projectType.gradle", name: "Gradle project", category: "projectType",
        description: "Project built and managed with Gradle using Groovy or Kotlin build scripts.",
        extensions: [".gradle", ".kts"], relatedIds: ["language.java"],
    },
    {
        id: "projectType.cmake", name: "CMake project", category: "projectType",
        description: "Project configured with CMake build descriptions such as CMakeLists.txt.",
        extensions: [".cmake", ".txt"], relatedIds: ["language.c", "language.cpp"],
    },
    {
        id: "projectType.cargo", name: "Cargo project", category: "projectType",
        description: "Rust project built and managed with Cargo using Cargo.toml.",
        extensions: [".toml"], relatedIds: ["language.rust"],
    },
    {
        id: "projectType.go", name: "Go module project", category: "projectType",
        description: "Go module project described by go.mod.",
        extensions: [".mod", ".sum"], relatedIds: ["language.go"],
    },
    {
        id: "projectType.python", name: "Python project", category: "projectType",
        description: "Python project using metadata such as pyproject.toml, setup.py or requirements.txt.",
        extensions: [".toml", ".py", ".txt"], relatedIds: ["language.python"],
    },
    {
        id: "projectType.dotnet", name: ".NET project", category: "projectType",
        description: ".NET project or solution described by project and solution files.",
        extensions: [".csproj", ".fsproj", ".vbproj", ".sln", ".slnx"], relatedIds: ["language.csharp"],
    },
];

/** Return a fresh directory whose objects and array fields share no mutable state. */
export const getDefaultEnvironments: () => EnvironmentEntry[] = (): EnvironmentEntry[] => DefaultEnvironments.map((entry: EnvironmentDefinition): EnvironmentEntry => ({
    ...entry,
    kind: "module",
    availability: "unknown",
    ...(entry.platforms === (void 0) ? {} : { platforms: [...entry.platforms] }),
    ...(entry.extensions === (void 0) ? {} : { extensions: [...entry.extensions] }),
    ...(entry.relatedIds === (void 0) ? {} : { relatedIds: [...entry.relatedIds] }),
    ...(entry.capabilities === (void 0) ? {} : { capabilities: [...entry.capabilities] }),
    ...(entry.skillIds === (void 0) ? {} : { skillIds: [...entry.skillIds] }),
    ...(entry.knowledgeIds === (void 0) ? {} : { knowledgeIds: [...entry.knowledgeIds] }),
    ...(entry.toolIds === (void 0) ? {} : { toolIds: [...entry.toolIds] }),
    ...(entry.protocolIds === (void 0) ? {} : { protocolIds: [...entry.protocolIds] }),
}));

/** Register missing defaults and return only the entries added by this call. */
export const loadDefaultEnvironments: (catalog: HostCatalog) => EnvironmentEntry[] = (catalog: HostCatalog): EnvironmentEntry[] => {
    const added: EnvironmentEntry[] = [];
    for (const entry of getDefaultEnvironments()) {
        if (!catalog.hasComponent(entry.id)) {
            catalog.addComponent(entry);
            added.push(entry);
        }
    }
    return added;
};
