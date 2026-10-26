/**
 * EntityManager-style facade: one connection, one repository per aggregate.
 *
 * Existing kernel modules keep their focused SQL; new modules (window, module
 * ports, mission queue) go through this facade so there is a single place to
 * see which tables an operation touches.
 */
import type { DatabaseSync } from "node:sqlite";

import { closeStore, openStore, transaction } from "../store/database.ts";
import { HandleRepository } from "../repository/handleRepository.ts";
import { MessageRepository } from "../repository/messageRepository.ts";
import { ObjectRepository } from "../repository/objectRepository.ts";
import { ProcessRepository } from "../repository/processRepository.ts";
import { AttestationRepository, ConceptRepository, ModuleRepository } from "../repository/registryRepository.ts";
import { StepRepository, WorkerRepository } from "../repository/workerRepository.ts";
import { ThreadRepository } from "../repository/threadRepository.ts";
import { WindowRepository } from "../repository/windowRepository.ts";
import { HandleService } from "./handleService.ts";
import { MessageService } from "./messageService.ts";
import { ObjectService } from "./objectService.ts";
import { ProcessService } from "./processService.ts";
import { AttestationService, ConceptService, ModuleService } from "./registryServices.ts";
import { StepService } from "./stepService.ts";
import { ThreadService } from "./threadService.ts";
import { WindowService } from "./windowService.ts";
import { WorkerService } from "./workerService.ts";

export class Database {
    readonly db: DatabaseSync;
    readonly objects: ObjectRepository;
    readonly processes: ProcessRepository;
    readonly threads: ThreadRepository;
    readonly handles: HandleRepository;
    readonly messages: MessageRepository;
    readonly workers: WorkerRepository;
    readonly steps: StepRepository;
    readonly windows: WindowRepository;
    readonly concepts: ConceptRepository;
    readonly modules: ModuleRepository;
    readonly attestations: AttestationRepository;
    readonly objectService: ObjectService;
    readonly processService: ProcessService;
    readonly threadService: ThreadService;
    readonly handleService: HandleService;
    readonly messageService: MessageService;
    readonly workerService: WorkerService;
    readonly stepService: StepService;
    readonly windowService: WindowService;
    readonly conceptService: ConceptService;
    readonly moduleService: ModuleService;
    readonly attestationService: AttestationService;

    constructor(path: string) {
        this.db = openStore(path);
        this.objects = new ObjectRepository(this.db);
        this.processes = new ProcessRepository(this.db);
        this.threads = new ThreadRepository(this.db);
        this.handles = new HandleRepository(this.db);
        this.messages = new MessageRepository(this.db);
        this.workers = new WorkerRepository(this.db);
        this.steps = new StepRepository(this.db);
        this.windows = new WindowRepository(this.db);
        this.concepts = new ConceptRepository(this.db);
        this.modules = new ModuleRepository(this.db);
        this.attestations = new AttestationRepository(this.db);
        this.objectService = new ObjectService(this.db, this.objects);
        this.processService = new ProcessService(this.db, this.processes);
        this.threadService = new ThreadService(this.db, this.threads);
        this.handleService = new HandleService(this.db, this.handles);
        this.messageService = new MessageService(this.messages);
        this.workerService = new WorkerService(this.db, this.workers);
        this.stepService = new StepService(this.steps);
        this.windowService = new WindowService(this.windows);
        this.conceptService = new ConceptService(this.db, this.concepts);
        this.moduleService = new ModuleService(this.db, this.modules);
        this.attestationService = new AttestationService(this.attestations);
    }

    transaction<T>(fn: () => T): T {
        return transaction(this.db, fn);
    }

    close(): void {
        closeStore(this.db);
    }
}
