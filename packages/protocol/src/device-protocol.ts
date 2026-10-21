import { z } from 'zod';

/**
 * Proposal for a transport-independent, explicitly authorised device-sharing
 * channel. No gateway currently accepts these messages, by design.
 */
export const MAX_DEVICE_SHARE_TEXT = 16_384;
export const deviceShareTextSchema = z.string().min(1).max(MAX_DEVICE_SHARE_TEXT);

/** Node -> Server: target only; the server derives the source from its authenticated socket. */
export const deviceShareSubmissionSchema = z.object({
    type: z.literal('device.share.submit'),
    requestId: z.string().uuid(),
    deliveryId: z.string().uuid(),
    targetNodeId: z.string().uuid(),
    text: deviceShareTextSchema,
}).strict();

/** Server -> Target Node: the server sets source and expiry only after authorisation. */
export const deviceShareDeliverySchema = z.object({
    type: z.literal('request'),
    kind: z.literal('device_share'),
    requestId: z.string().uuid(),
    deliveryId: z.string().uuid(),
    sourceNodeId: z.string().uuid(),
    text: deviceShareTextSchema,
    expiresAt: z.iso.datetime({ offset: true }),
}).strict();

/** A receiving Node must explicitly accept; queueing alone is not delivery. */
export const deviceShareReceiptSchema = z.object({
    accepted: z.boolean(),
}).strict();

export type DeviceShareSubmission = z.infer<typeof deviceShareSubmissionSchema>;
export type DeviceShareDelivery = z.infer<typeof deviceShareDeliverySchema>;
export type DeviceShareReceipt = z.infer<typeof deviceShareReceiptSchema>;
