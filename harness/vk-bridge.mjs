/**
 * WebX Host VK Bridge
 *
 * Receives the binary Vulkan command stream from the Canary guest via the
 * TCP socket bridge.  Deserializes each packet and dispatches to the active
 * VkWebGPU-ICD plugin.
 *
 * ## Transport (Canary TCP socket IPC)
 *
 *   Guest ICD connects to 127.0.0.1:0x7860 (TCP).
 *   Canary intercepts the connect() and routes it through drain_connect_requests().
 *   JS intercepts the fd and wires it to this bridge in-process (no real socket).
 *
 *   Guest → Host: write(fd, packet, len)  → drain_socket_sends()  → handleWrite()
 *   Host → Guest: onResponseReady(resp)   → rt.socket_recv_data(fd, resp)
 *
 * ## Usage (canary-host.mjs)
 *
 *   const bridge = new VkBridge(plugin);
 *   bridge.onResponseReady = (resp) => rt.socket_recv_data(vkFd, resp);
 *   // In pollNetwork():
 *   bridge.handleWrite(b64ToBytes(send.data));
 */

const WEBX_MAGIC       = 0x58574756; /* "VGWX" in little-endian */
const HEADER_SIZE      = 16;         /* magic(4) + cmd(4) + seq(4) + len(4) */
const RESP_HEADER_SIZE = 12;         /* seq(4) + result(4) + len(4) */

export class VkBridge {
    #plugin           = null;
    #recvBuf          = new Uint8Array(0); /* partial packet accumulation */
    #responseQueue    = [];                /* pending responses (legacy pull model) */
    #pendingRead      = null;             /* legacy: { resolve } waiting for data */
    #onResponseReady  = null;             /* push model: called when response built */

    constructor(plugin) {
        this.#plugin = plugin;
    }

    /**
     * Set a callback invoked whenever a complete response packet is ready.
     * Used by the MessagePort transport: the callback does hostPort.postMessage(resp).
     * When set, this takes priority over the pull-model queue/pendingRead.
     *
     * @param {((resp: Uint8Array) => void) | null} cb
     */
    set onResponseReady(cb) {
        this.#onResponseReady = cb;
    }

    /**
     * Feed incoming bytes from the guest.
     * May be called one byte at a time (from the port listener) or in bulk.
     * Buffers internally until a complete packet is available.
     *
     * @param {Uint8Array} data
     */
    handleWrite(data) {
        const merged = new Uint8Array(this.#recvBuf.length + data.length);
        merged.set(this.#recvBuf);
        merged.set(data, this.#recvBuf.length);
        this.#recvBuf = merged;
        this.#processBuffer();
    }

    /**
     * Pull-model read (legacy, used by processPacket).
     * Returns a Promise resolving with the next complete response Uint8Array.
     *
     * @returns {Promise<Uint8Array>}
     */
    handleRead() {
        if (this.#responseQueue.length > 0)
            return Promise.resolve(this.#responseQueue.shift());
        return new Promise(resolve => { this.#pendingRead = { resolve }; });
    }

    /**
     * Convenience: feed one complete command packet, wait for response.
     * Used when the caller already has the full packet (e.g. tests).
     *
     * @param {Uint8Array} cmdData
     * @returns {Promise<Uint8Array>}
     */
    async processPacket(cmdData) {
        this.handleWrite(cmdData);
        return this.handleRead();
    }

    /* ── Internal ──────────────────────────────────────────────────────── */

    #processBuffer() {
        while (this.#recvBuf.length >= HEADER_SIZE) {
            const view = new DataView(this.#recvBuf.buffer,
                                      this.#recvBuf.byteOffset,
                                      this.#recvBuf.byteLength);

            const magic = view.getUint32(0, true);
            if (magic !== WEBX_MAGIC) {
                console.error('[VkBridge] Bad magic 0x' + magic.toString(16) +
                              ' — desync, dropping buffer');
                this.#recvBuf = new Uint8Array(0);
                return;
            }

            const cmd    = view.getUint32(4,  true);
            const seq    = view.getUint32(8,  true);
            const payLen = view.getUint32(12, true);
            const total  = HEADER_SIZE + payLen;

            if (this.#recvBuf.length < total) break; /* wait for more bytes */

            const payload     = this.#recvBuf.slice(HEADER_SIZE, total);
            this.#recvBuf     = this.#recvBuf.slice(total);

            this.#dispatch(cmd, seq, payload);
        }
    }

    async #dispatch(cmd, seq, payload) {
        let result, data;
        try {
            ({ result, data } = await this.#plugin.dispatch(cmd, seq, payload));
        } catch (err) {
            console.error('[VkBridge] plugin.dispatch threw:', err);
            result = -4; /* VK_ERROR_DEVICE_LOST */
            data   = new Uint8Array(0);
        }

        const respPayload = data ?? new Uint8Array(0);
        const resp = new Uint8Array(RESP_HEADER_SIZE + respPayload.length);
        const rv   = new DataView(resp.buffer);
        rv.setUint32(0, seq,                true);
        rv.setInt32 (4, result,             true);
        rv.setUint32(8, respPayload.length, true);
        resp.set(respPayload, RESP_HEADER_SIZE);

        /* Push model: send via MessagePort (preferred) */
        if (this.#onResponseReady) {
            this.#onResponseReady(resp);
            return;
        }

        /* Pull model: resolve pending handleRead() or enqueue */
        if (this.#pendingRead) {
            const { resolve } = this.#pendingRead;
            this.#pendingRead = null;
            resolve(resp);
        } else {
            this.#responseQueue.push(resp);
        }
    }
}
