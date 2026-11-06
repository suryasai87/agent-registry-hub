// Quick actions for lists of AssetCards (Catalog, Home): hosts the Subscribe / Request access dialogs and
// applies the optimistic subscribe (count + pill) with rollback when the server refuses.
import { useCallback, useState } from "react";
import { useSession } from "../../lib/session";
import type { AccessRequest, AssetCard } from "../../lib/types";
import { useToast } from "../ui";
import RequestAccessDialog from "./RequestAccessDialog";
import SubscribeDialog, { postSubscription, type SubscribeBody } from "./SubscribeDialog";

export type UpdateCard = (assetId: string, fn: (card: AssetCard) => AssetCard) => void;

export function useSessionEmail(): string {
  const session = useSession();
  return session.me?.email ?? session.user?.email ?? "";
}

export function applyRequest(card: AssetCard, req: AccessRequest): AssetCard {
  const granted = req.status === "provisioned" || req.status === "approved";
  const pending = req.status === "pending" || req.status === "provisioning";
  return {
    ...card,
    subscribers: req.subscribe_email && !card.my.subscribed ? card.subscribers + 1 : card.subscribers,
    my: { ...card.my, has_access: card.my.has_access || granted, requested: card.my.requested || pending, subscribed: card.my.subscribed || !!req.subscribe_email },
  };
}

export default function useCardActions(updateCard: UpdateCard) {
  const [subFor, setSubFor] = useState<AssetCard | null>(null);
  const [reqFor, setReqFor] = useState<AssetCard | null>(null);
  const [subOpen, setSubOpen] = useState(false);
  const [reqOpen, setReqOpen] = useState(false);
  const email = useSessionEmail();
  const toast = useToast();

  const subscribe = useCallback((card: AssetCard) => {
    setSubFor(card);
    setSubOpen(true);
  }, []);
  const requestAccess = useCallback((card: AssetCard) => {
    setReqFor(card);
    setReqOpen(true);
  }, []);

  const submitSubscribe = async (body: SubscribeBody) => {
    if (!subFor) return;
    const card = subFor;
    updateCard(card.asset_id, (c) => ({ ...c, subscribers: c.subscribers + (c.my.subscribed ? 0 : 1), my: { ...c.my, subscribed: true } }));
    try {
      await postSubscription(card.asset_id, body);
      toast.success(`Subscribed to ${card.display_name}`, `Notifications go to ${body.subscriber_email}.`);
    } catch (err) {
      updateCard(card.asset_id, (c) => ({ ...c, subscribers: card.subscribers, my: { ...c.my, subscribed: card.my.subscribed } }));
      throw err;
    }
  };

  const dialogs = (
    <>
      {subFor && <SubscribeDialog open={subOpen} onClose={() => setSubOpen(false)} asset={subFor} defaultEmail={email} onSubmit={submitSubscribe} />}
      {reqFor && (
        <RequestAccessDialog
          open={reqOpen}
          onClose={() => setReqOpen(false)}
          asset={reqFor}
          defaultEmail={email}
          onSubmitted={(req) => updateCard(reqFor.asset_id, (c) => applyRequest(c, req))}
        />
      )}
    </>
  );

  return { dialogs, subscribe, requestAccess };
}
