/* @ts-self-types="./canary_wasm.d.ts" */

import * as wasm from "./canary_wasm_bg.wasm";
import { __wbg_set_wasm } from "./canary_wasm_bg.js";
__wbg_set_wasm(wasm);
wasm.__wbindgen_start();
export {
    CanaryRuntime, fetch_ext2_file, lookup_ext2_path, stage_vfs_from_url
} from "./canary_wasm_bg.js";
