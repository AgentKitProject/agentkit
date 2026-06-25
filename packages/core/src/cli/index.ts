#!/usr/bin/env node
import { createCliProgram } from "./program.js";

const program = createCliProgram();
await program.parseAsync();
