# Group direct interactions into bounded waves

Loom groups direct Interaction Inputs from one Interaction Place into a durable Interaction Wave, closes it after 1.5 seconds of quiet or 6 seconds from its first Input, and steers same-wave Inputs into the active Turn together. A reply or `no_reply` decision is accepted only after the wave closes and every still-unsettled Input in it has been included; this follows the human rhythm of speaking through a short burst without making the Individual wait forever, while activity from other places and ambient channel traffic remain separate.

## Wave vs. reply gate

The wave is only a short-lived batching boundary for human input bursts; it is not the reply boundary. The reply gate is scoped to the whole Interaction scope (routeRef + placeRef): every Interaction of that scope that is still pending or active when the first send/no_reply decision is committed must be included in the Turn first. Consequently a Turn claims every pending Input of its scope — including Inputs from earlier or later waves that were accepted before the Turn started — so that a single reply does not silently ignore a message the human already sent. Inputs accepted after the gate closes belong to the next Turn, and a no_reply or send with `after_send=continue` re-checks the same window against the closed boundary.

This contract is enforced on the claim path (`#pendingScopeInteractionInputs`), on the steering path for Inputs accepted while the Turn is running, and on the commit path (scope coverage check). The 1.5s/6s wave limits only decide how long a reply waits for more burst input; they never decide whether an already-accepted Input may be left for a later Turn.
