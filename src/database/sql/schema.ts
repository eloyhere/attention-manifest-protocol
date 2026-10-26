/**
 * DDL for the SQLite store. Migrations live in the store, not here.
 */

export const MetaSchema: string = `
CREATE TABLE IF NOT EXISTS meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
`;

export const Schema: string = `
CREATE TABLE IF NOT EXISTS objects (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT NOT NULL,
    id TEXT NOT NULL,
    body TEXT NOT NULL,
    hash TEXT NOT NULL,
    prev TEXT NOT NULL,
    at TEXT NOT NULL,
    UNIQUE(kind, id)
);
CREATE INDEX IF NOT EXISTS objects_kind_seq ON objects(kind, seq);

CREATE TABLE IF NOT EXISTS processes (
    pid INTEGER PRIMARY KEY AUTOINCREMENT,
    id TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    role TEXT,
    state TEXT NOT NULL CHECK(state IN ('created','running','idle','suspended','terminated')),
    priority INTEGER NOT NULL DEFAULT 0,
    budget TEXT NOT NULL,
    used TEXT NOT NULL,
    parent_pid INTEGER REFERENCES processes(pid),
    created_at TEXT NOT NULL,
    started_at TEXT,
    terminated_at TEXT,
    exit_code TEXT,
    exit_note TEXT,
    version INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS processes_state ON processes(state, priority DESC);

CREATE TABLE IF NOT EXISTS threads (
    tid INTEGER PRIMARY KEY AUTOINCREMENT,
    id TEXT NOT NULL UNIQUE,
    pid INTEGER NOT NULL REFERENCES processes(pid) ON DELETE CASCADE,
    goal TEXT NOT NULL,
    statement TEXT NOT NULL,
    success TEXT NOT NULL,
    state TEXT NOT NULL CHECK(state IN ('ready','running','blocked','done','failed','abandoned')),
    priority INTEGER NOT NULL DEFAULT 0,
    quantum_ms INTEGER NOT NULL DEFAULT 1000,
    slice_used_ms INTEGER NOT NULL DEFAULT 0,
    budget TEXT NOT NULL,
    used TEXT NOT NULL,
    blocked_on TEXT,
    wake_at TEXT,
    created_at TEXT NOT NULL,
    finished_at TEXT,
    exit_note TEXT,
    owner_worker TEXT,
    lease INTEGER NOT NULL DEFAULT 0,
    version INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS threads_ready ON threads(state, priority DESC, tid);
CREATE INDEX IF NOT EXISTS threads_pid ON threads(pid, state);
CREATE UNIQUE INDEX IF NOT EXISTS threads_one_running_per_process ON threads(pid) WHERE state = 'running';

CREATE TABLE IF NOT EXISTS steps (
    step_id INTEGER PRIMARY KEY AUTOINCREMENT,
    pid INTEGER NOT NULL,
    tid INTEGER NOT NULL,
    at TEXT NOT NULL,
    outcome TEXT NOT NULL,
    usage TEXT NOT NULL,
    note TEXT,
    receipt_id TEXT
);
CREATE INDEX IF NOT EXISTS steps_pid ON steps(pid, step_id);

/* Address space: which immutable objects a process can see. Inherited rows are
   copy-on-write views of the parent's warrant; writing creates a new object. */
CREATE TABLE IF NOT EXISTS process_objects (
    pid INTEGER NOT NULL REFERENCES processes(pid) ON DELETE CASCADE,
    seq INTEGER NOT NULL REFERENCES objects(seq) ON DELETE CASCADE,
    role TEXT NOT NULL CHECK(role IN ('own','inherited','mapped','joined')),
    mode TEXT NOT NULL CHECK(mode IN ('read','write')),
    attached_at TEXT NOT NULL,
    PRIMARY KEY (pid, seq)
);
CREATE INDEX IF NOT EXISTS process_objects_pid ON process_objects(pid, seq);

/* Capability table: a handle is an unforgeable row over ANY resource, carrying
   rights, scope and expiry. Ownership is implicit for the owner process; every
   other subject needs a row here. Grants create a child row in another subject,
   and revoke walks the tree, so a revoked parent invalidates every grant below
   it. This is the only isolation mechanism a logical process has. */
CREATE TABLE IF NOT EXISTS handles (
    hid INTEGER PRIMARY KEY AUTOINCREMENT,
    id TEXT NOT NULL UNIQUE,
    subject_kind TEXT NOT NULL CHECK(subject_kind IN ('host','process','thread')),
    subject_id TEXT NOT NULL,
    subject_pid INTEGER,
    resource_kind TEXT NOT NULL CHECK(resource_kind IN ('object','process','thread','mailbox','budget')),
    resource_id TEXT NOT NULL,
    owner_pid INTEGER,
    rights TEXT NOT NULL,
    scope TEXT NOT NULL CHECK(scope IN ('process','thread','shared')),
    parent_hid INTEGER REFERENCES handles(hid),
    refcount INTEGER NOT NULL DEFAULT 1,
    expires_at TEXT,
    revoked_at TEXT,
    granted_by TEXT,
    created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS handles_subject ON handles(subject_kind, subject_id, resource_kind, resource_id);
CREATE INDEX IF NOT EXISTS handles_parent ON handles(parent_hid);

/* Inter-process messages: bounded mailbox per recipient, delivered exactly once
   by delivered_at; the delivery writes a receipt object so the exchange is in
   the evidence chain. Intra-process traffic uses the blackboard, not this table. */
CREATE TABLE IF NOT EXISTS messages (
    msg_id INTEGER PRIMARY KEY AUTOINCREMENT,
    id TEXT NOT NULL UNIQUE,
    from_pid INTEGER NOT NULL REFERENCES processes(pid),
    from_tid INTEGER NOT NULL,
    to_pid INTEGER NOT NULL REFERENCES processes(pid),
    to_tid INTEGER,
    kind TEXT NOT NULL CHECK(kind IN ('request','response','event','signal')),
    body TEXT NOT NULL,
    correlation_id TEXT,
    at TEXT NOT NULL,
    delivered_at TEXT,
    receipt_id TEXT
);
CREATE INDEX IF NOT EXISTS messages_inbox ON messages(to_pid, delivered_at, msg_id);

/* Worker registry: every kernel instance that touches the store has an entry
   and a heartbeat. A thread is owned by exactly one worker (fencing lease), so
   another worker can recover it only after the owner's lease expires. */
CREATE TABLE IF NOT EXISTS workers (
    worker_id TEXT PRIMARY KEY,
    host TEXT,
    pid INTEGER,
    started_at TEXT NOT NULL,
    heartbeat_at TEXT NOT NULL,
    expires_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS workers_expiry ON workers(expires_at);

/* Idempotency: external effects and message sends are keyed, so a retry after a
   crash returns the stored result instead of performing the effect twice. */
CREATE TABLE IF NOT EXISTS idempotency (
    key TEXT PRIMARY KEY,
    result TEXT NOT NULL,
    created_at TEXT NOT NULL
);

/* Context window: a per-thread address space. Pages point at immutable objects;
   the page table is durable so a restart can rebuild the resident set instead
   of pretending the model still remembers it. */
CREATE TABLE IF NOT EXISTS windows (
    tid INTEGER PRIMARY KEY,
    capacity_tokens INTEGER NOT NULL,
    used_tokens INTEGER NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS window_pages (
    tid INTEGER NOT NULL,
    page_id TEXT NOT NULL,
    object_kind TEXT NOT NULL,
    object_id TEXT NOT NULL,
    tokens INTEGER NOT NULL,
    pinned INTEGER NOT NULL,
    last_used INTEGER NOT NULL,
    PRIMARY KEY (tid, page_id)
);
CREATE INDEX IF NOT EXISTS window_pages_tid ON window_pages(tid, last_used);

/* Cross-worker mutual exclusion for a named resource (file, session, tab).
   A lease is a capability's sibling: permission says "may", a lock says "now". */
CREATE TABLE IF NOT EXISTS resource_locks (
    name TEXT PRIMARY KEY,
    holder TEXT NOT NULL,
    fencing INTEGER NOT NULL DEFAULT 0,
    acquired_at TEXT NOT NULL,
    expires_at TEXT NOT NULL
);

/* Registry: concepts and modules are data, not only directories.
   Each declaration writes an object; the row keeps the latest version and the
   object seq, so "this module exists" is a checkable claim, not a convention. */
CREATE TABLE IF NOT EXISTS concepts (
    cid INTEGER PRIMARY KEY AUTOINCREMENT,
    id TEXT NOT NULL UNIQUE,
    label TEXT NOT NULL,
    definition TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('proposed','active','deprecated')),
    version INTEGER NOT NULL,
    object_seq INTEGER,
    digest TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS modules (
    mid INTEGER PRIMARY KEY AUTOINCREMENT,
    id TEXT NOT NULL UNIQUE,
    kind TEXT NOT NULL CHECK(kind IN ('kernel','database','domain','protocol','module','structure','tool','boundary')),
    entry TEXT NOT NULL,
    description TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('planned','active','deprecated')),
    version INTEGER NOT NULL,
    object_seq INTEGER,
    digest TEXT,
    content_digest TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS module_concepts (
    mid INTEGER NOT NULL REFERENCES modules(mid) ON DELETE CASCADE,
    cid INTEGER NOT NULL REFERENCES concepts(cid) ON DELETE CASCADE,
    role TEXT NOT NULL CHECK(role IN ('owns','uses','constrains','implements')),
    PRIMARY KEY (mid, cid, role)
);

CREATE TABLE IF NOT EXISTS module_dependencies (
    mid INTEGER NOT NULL REFERENCES modules(mid) ON DELETE CASCADE,
    depends_on_mid INTEGER NOT NULL REFERENCES modules(mid) ON DELETE CASCADE,
    reason TEXT,
    PRIMARY KEY (mid, depends_on_mid)
);

CREATE TABLE IF NOT EXISTS attestations (
    aid INTEGER PRIMARY KEY AUTOINCREMENT,
    subject_kind TEXT NOT NULL CHECK(subject_kind IN ('concept','module')),
    subject_id TEXT NOT NULL,
    claim_id TEXT NOT NULL,
    object_seq INTEGER,
    at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS attestations_subject ON attestations(subject_kind, subject_id);

/* Person layer: an agent is a person, not a prompt.
   Self is narrative (versioned), roles are social positions, memory is typed,
   affect is state, relationships and institutions constitute the social person. */
CREATE TABLE IF NOT EXISTS person_profiles (
    pid INTEGER PRIMARY KEY REFERENCES processes(pid) ON DELETE CASCADE,
    name TEXT NOT NULL,
    narrative TEXT NOT NULL DEFAULT '',
    values_json TEXT NOT NULL DEFAULT '[]',
    constraints_json TEXT NOT NULL DEFAULT '[]',
    life_chapter TEXT NOT NULL DEFAULT 'starting',
    updated_at TEXT NOT NULL,
    version INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS self_narratives (
    snid INTEGER PRIMARY KEY AUTOINCREMENT,
    pid INTEGER NOT NULL REFERENCES processes(pid) ON DELETE CASCADE,
    version INTEGER NOT NULL,
    identity_json TEXT NOT NULL DEFAULT '{}',
    narrative TEXT NOT NULL,
    at TEXT NOT NULL,
    object_seq INTEGER,
    UNIQUE(pid, version)
);

CREATE TABLE IF NOT EXISTS roles (
    rid INTEGER PRIMARY KEY AUTOINCREMENT,
    id TEXT NOT NULL UNIQUE,
    label TEXT NOT NULL,
    obligations_json TEXT NOT NULL DEFAULT '[]',
    permissions_json TEXT NOT NULL DEFAULT '[]',
    audiences_json TEXT NOT NULL DEFAULT '[]',
    scripts_json TEXT NOT NULL DEFAULT '[]',
    status TEXT NOT NULL CHECK(status IN ('active','retired')) DEFAULT 'active',
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS person_roles (
    pid INTEGER NOT NULL REFERENCES processes(pid) ON DELETE CASCADE,
    rid INTEGER NOT NULL REFERENCES roles(rid) ON DELETE CASCADE,
    salience REAL NOT NULL DEFAULT 0.5,
    active INTEGER NOT NULL DEFAULT 0,
    since TEXT NOT NULL,
    PRIMARY KEY (pid, rid)
);
CREATE UNIQUE INDEX IF NOT EXISTS person_roles_one_active ON person_roles(pid) WHERE active = 1;

CREATE TABLE IF NOT EXISTS memories (
    mem_id INTEGER PRIMARY KEY AUTOINCREMENT,
    id TEXT NOT NULL UNIQUE,
    pid INTEGER NOT NULL REFERENCES processes(pid) ON DELETE CASCADE,
    role_id TEXT,
    kind TEXT NOT NULL CHECK(kind IN ('episodic','semantic','procedural','social','affective')),
    content TEXT NOT NULL,
    salience REAL NOT NULL DEFAULT 0.5,
    at TEXT NOT NULL,
    refs_json TEXT NOT NULL DEFAULT '[]',
    source TEXT,
    consolidated INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS memories_pid ON memories(pid, salience DESC, at DESC);

CREATE TABLE IF NOT EXISTS affect_states (
    pid INTEGER PRIMARY KEY REFERENCES processes(pid) ON DELETE CASCADE,
    valence REAL NOT NULL DEFAULT 0,
    arousal REAL NOT NULL DEFAULT 0,
    stress REAL NOT NULL DEFAULT 0,
    fatigue REAL NOT NULL DEFAULT 0,
    mood TEXT NOT NULL DEFAULT 'neutral',
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS relationships (
    rel_id INTEGER PRIMARY KEY AUTOINCREMENT,
    id TEXT NOT NULL UNIQUE,
    from_pid INTEGER NOT NULL REFERENCES processes(pid) ON DELETE CASCADE,
    to_pid INTEGER NOT NULL REFERENCES processes(pid) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    trust REAL NOT NULL DEFAULT 0.5,
    attachment REAL NOT NULL DEFAULT 0.5,
    obligations_json TEXT NOT NULL DEFAULT '[]',
    since TEXT NOT NULL,
    last_contact TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS relationships_pair ON relationships(from_pid, to_pid, kind);

CREATE TABLE IF NOT EXISTS institutions (
    iid INTEGER PRIMARY KEY AUTOINCREMENT,
    id TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    norms_json TEXT NOT NULL DEFAULT '[]'
);

CREATE TABLE IF NOT EXISTS memberships (
    pid INTEGER NOT NULL REFERENCES processes(pid) ON DELETE CASCADE,
    iid INTEGER NOT NULL REFERENCES institutions(iid) ON DELETE CASCADE,
    role TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('active','left')) DEFAULT 'active',
    since TEXT NOT NULL,
    PRIMARY KEY (pid, iid)
);

CREATE TABLE IF NOT EXISTS background_processes (
    bpid INTEGER PRIMARY KEY AUTOINCREMENT,
    id TEXT NOT NULL UNIQUE,
    pid INTEGER NOT NULL REFERENCES processes(pid) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK(kind IN ('habit','emotion','monitor','drive')),
    label TEXT NOT NULL,
    intensity REAL NOT NULL DEFAULT 0.5,
    trigger TEXT,
    script TEXT,
    status TEXT NOT NULL CHECK(status IN ('active','paused','retired')) DEFAULT 'active',
    updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS background_pid ON background_processes(pid, status, intensity DESC);

CREATE TABLE IF NOT EXISTS life_events (
    ev_id INTEGER PRIMARY KEY AUTOINCREMENT,
    id TEXT NOT NULL UNIQUE,
    pid INTEGER NOT NULL REFERENCES processes(pid) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    summary TEXT NOT NULL,
    at TEXT NOT NULL,
    role_id TEXT,
    impact REAL NOT NULL DEFAULT 0.5,
    narrative_version INTEGER
);
CREATE INDEX IF NOT EXISTS life_events_pid ON life_events(pid, at DESC);

/* Transactional outbox for runtime receipts/events. Rows are written by the
   application transaction and dispatched later; this keeps the runtime sink
   observable without making the domain depend on SQLite. */
CREATE TABLE IF NOT EXISTS outbox (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    topic TEXT NOT NULL,
    payload TEXT NOT NULL,
    created_at TEXT NOT NULL,
    dispatched_at TEXT
);
CREATE INDEX IF NOT EXISTS outbox_pending ON outbox(dispatched_at, id);

/* Runtime session snapshots (attention state + priors + history). */
CREATE TABLE IF NOT EXISTS runtime_sessions (
    pid INTEGER PRIMARY KEY,
    data TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

/* Queryable turn snapshots (JSON includes actions/operations/behavior). */
CREATE TABLE IF NOT EXISTS runtime_turns (
    id TEXT PRIMARY KEY,
    pid INTEGER NOT NULL,
    session_id TEXT,
    data TEXT NOT NULL,
    created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS runtime_turns_pid ON runtime_turns(pid, created_at DESC);

/* Independent approval audit rows; the outbox carries the dispatch copy. */
CREATE TABLE IF NOT EXISTS runtime_approvals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    pid INTEGER NOT NULL,
    turn_id TEXT NOT NULL,
    operation_id TEXT NOT NULL,
    tool TEXT NOT NULL,
    risk TEXT NOT NULL,
    decision TEXT NOT NULL,
    status TEXT NOT NULL,
    created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS runtime_approvals_pid ON runtime_approvals(pid, id DESC);
`;
