import { expect } from "vitest";
import * as matchers from "@testing-library/jest-dom/matchers";

// Extend vitest's expect with jest-dom matchers (toHaveClass, toBeDisabled, …).
// Importing the matchers module and calling expect.extend explicitly is the
// vitest-4-safe form: the auto-extending "@testing-library/jest-dom/vitest"
// entry extends an expect instance that, under vitest 4's runner, did not match
// the one used by the tests (→ "Invalid Chai property" failures).
expect.extend(matchers);
