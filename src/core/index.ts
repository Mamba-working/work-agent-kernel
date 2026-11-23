// Public contracts for hosts, adapter authors and business hooks.
export { createRouterApplication } from './application.ts';
export type { ApplicationOptions } from './application.ts';
export type { Source, Router, Harness, NotificationSink, Plugins } from './ports.ts';
export type { Event, WorkRequest, WorkItem, Notice, Report, Receipt } from './domain.ts';
export type { PlanningRuntime, PlanningRequest, ContextReader, Catalog } from './planning/contracts.ts';
export type { EventContextAdapter } from './planning/incoming.ts';
export type { LifecycleHook, HookInput, HookDecision, HookEffect, HookFacts, Resolution } from './hooks/lifecycle.ts';
