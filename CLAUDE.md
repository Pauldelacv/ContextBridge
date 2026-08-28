# CLAUDE.md — ContextBridge

## Project Context

You are building **ContextBridge**, a production-quality AI knowledge layer that connects fragmented company knowledge and makes it accessible through a unified AI interface.

This is a portfolio project

The goal is not simply to build another RAG chatbot.

The project must demonstrate the ability to:

- Understand a messy enterprise problem
- Integrate multiple third-party systems
- Design a reliable data ingestion pipeline
- Handle authentication and APIs
- Build asynchronous workflows
- Design a multi-tenant architecture
- Implement vector search and retrieval
- Handle synchronization and document updates
- Build a usable interface
- Make pragmatic technical decisions
- Deploy a complete production-style system


---

# Product

## Name

ContextBridge

## Tagline

**An AI knowledge layer that connects fragmented company knowledge.**

## Problem

Companies store knowledge across many disconnected systems:

- Notion
- Google Drive
- Slack
- Internal documentation
- Future integrations

Employees waste time searching for information or asking colleagues questions that already have an answer somewhere in the company.

The information exists.

The problem is that it is fragmented.

ContextBridge creates a unified AI-accessible knowledge layer.

---

# Core User Flow

A company connects its data sources.

Example:

```text
Notion
Google Drive
Slack
        ↓
Integration Layer
        ↓
Ingestion Pipeline
        ↓
PostgreSQL + pgvector
        ↓
Retrieval Layer
        ↓
LLM
        ↓
Slack / Web Interface