import React, { useEffect, useState } from "react";
import { Text, View } from "react-native";
import { Button, Card, useDesign } from "./components";
import { ErrorNotice } from "./Notice";

export function GalleryDeletionReview({ actions, volume, confirm }) {
  const { s } = useDesign();
  const [requests, setRequests] = useState([]),
    [originals, setOriginals] = useState([]);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const refresh = async () => {
    setRequests(await actions.pending(volume));
    setOriginals(await actions.reviews(volume));
  };
  useEffect(() => {
    refresh().catch((e) => setError(e.message));
  }, [volume]);
  async function run(work) {
    setBusy(true);
    setError("");
    try {
      await work();
      await refresh();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <View style={s.group}>
      <Text style={s.text}>
        Shared deletions wait for a connection and resumed sync. Canceling a
        pending request cannot undo a deletion already accepted by the hub.
        Originals stay on this phone until you review them here. Canceling a
        system prompt keeps the original; it does not undo a shared deletion.
      </Text>
      {!!error && <ErrorNotice error={error} />}
      {requests.map((item) => (
        <Card key={item.id} title={item.path.split("/").pop()}>
          <Text style={s.caption}>{item.issue || "Deletion pending"}</Text>
          <Button
            label="Cancel pending deletion"
            disabled={busy}
            onPress={() => run(() => actions.cancel(volume, item.id))}
          />
        </Card>
      ))}
      {originals.map((item) => (
        <Card key={item.seq} title={item.name || "Photo"}>
          <Text style={s.caption}>
            Deleted from Arca. Review by{" "}
            {new Date(item.expires).toLocaleDateString()}.
          </Text>
          <Button
            label="Restore in Arca"
            disabled={busy}
            onPress={() => run(() => actions.restore(volume, item))}
          />
          {item.state === "pending" && (
            <Button
              label="Keep original"
              disabled={busy}
              onPress={() => run(() => actions.keep(volume, [item.seq]))}
            />
          )}
          {item.state === "pending" && (
            <Button
              label="Remove original…"
              danger
              disabled={busy}
              onPress={() =>
                confirm(
                  "Remove this original from Photos?",
                  "Arca will verify that every resource still matches the uploaded photo. iCloud Photos may remove it on your other Apple devices too. Android moves it to trash. The hub keeps a recovery copy until the review deadline.",
                  () => run(() => actions.removeOriginals(volume, [item.seq])),
                  "Remove original",
                )
              }
            />
          )}
        </Card>
      ))}
      {!requests.length && !originals.length && (
        <Text style={s.caption}>No deletions need review.</Text>
      )}
    </View>
  );
}
