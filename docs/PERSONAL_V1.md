# Personal Builder v1

This document is the operator-facing feature specification for Agent Foundry's first complete product release. [PRODUCT_CONTRACT.md](PRODUCT_CONTRACT.md) is normative; this document explains how the contract behaves.

## Experience

The home screen starts with chat. A short idea is enough. Agent Foundry asks only material questions, then creates a plan and runs the complete pipeline. A PRD is generated as a versioned artifact rather than required as input.

The builder has three primary surfaces:

1. **Chat:** requests, questions, progress, approvals and final summaries.
2. **Preview:** the running app, viewport controls, element selection, browser logs and verification evidence.
3. **Changes:** plan, diff, checks, versions, draft failures, deployment and rollback actions.

Every Build operation invokes planner, plan reviewer, architect, architecture reviewer, developer, code reviewer, deterministic verifier, browser verifier, repair loops and final release assessment. The router may select a different provider for every role.

## Visual editing

The user can select an element and describe a change or use direct controls for text, color, spacing, typography, layout and design tokens. A visual change is never a hidden DOM-only mutation: it becomes a source patch, receives a preview, and passes the normal pipeline before promotion.

Reference images can guide design or reproduce defects. V1 does not create or edit raster assets.

## Versions and recovery

One accepted operation creates one Git commit and one immutable project version. A revert creates a new version rather than rewriting history. If the pipeline exhausts its emergency ceiling, the last verified version stays active and the failed work remains on a draft branch with its artifacts.

## Local application environment

Every project owns its own Compose project and Supabase data volumes. Agent Foundry can initialize, start, stop, inspect, migrate, seed, health-check and clean up the environment. Destructive reset and migration actions require confirmation.

Authentication is enabled from project creation. V1 provides signup, login, logout, sessions, protected routes and baseline RLS. Password reset is an administrator operation; there is no production email-delivery promise.

## Deployment

The owner registers one or more existing VPS targets using SSH details in local `.env` configuration. Ubuntu LTS is the verified target and Debian compatibility is best effort.

A production release creates or updates an isolated directory and Compose project, validates health, and exposes a host/port endpoint. If the owner has already pointed a domain at the VPS, Agent Foundry validates the record and configures Caddy with automatic TLS.

Rollback redeploys a previous application image/configuration. It does not roll back the database. Migrations are forward-moving; destructive migrations need approval. Database and storage backups run on a schedule, remain on the VPS according to retention policy, and are copied to the local Mac. Restore is always explicit.

## V1 acceptance application

Issue Radar remains the canonical proof. A release candidate is not ready because individual components work; it is ready only after the complete Issue Radar journey passes from a clean macOS installation and a clean Ubuntu LTS VPS.
