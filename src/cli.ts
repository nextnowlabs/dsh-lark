#!/usr/bin/env node
/**
 * Executable entry for the `dsh-lark` command. Kept apart from
 * {@link module:@nextnowlabs/dsh-lark/provision} so importing the logic — from a
 * test, or from another tool — never runs it.
 * @module @nextnowlabs/dsh-lark/cli
 */

import { main } from './provision.ts'

await main(process.argv.slice(2))
