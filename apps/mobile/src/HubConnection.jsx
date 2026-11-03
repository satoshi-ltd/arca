import React from "react";
import { Button, MachineRow, useDesign } from "./components";
import { deviceCells, deviceSegments, foldRowFits } from "./device-line.js";
export function HubConnection({
  connection,
  name,
  machine,
  presence,
  busy,
  actions,
  retry,
  grouped = false,
}) {
  const { wide: wideLayout, fontScale = 1 } = useDesign();
  const wide = wideLayout && foldRowFits(fontScale);
  const address = new URL(connection.url);
  return (
    <MachineRow
      grouped={grouped}
      hub
      role="Hub"
      name={name || "Hub"}
      platform={machine?.platform}
      segments={deviceSegments({
        platform: machine?.platform,
        folders: machine?.selectedFolders,
        size: machine?.indexedBytes,
      })}
      cells={deviceCells({
        version: machine?.version,
        folders: machine?.selectedFolders,
        size: machine?.indexedBytes,
      })}
      presence={presence}
      address={[address.host, connection.leaving ? "Disconnection pending" : ""]
        .filter(Boolean)
        .join(" · ")}
      actions={
        connection.leaving ? (
          <Button iconOnly={!wide} size="small" icon="unplug" label="Retry disconnect" disabled={busy} onPress={retry} />
        ) : (
          <Button iconOnly size="small" icon="more" label={`Actions for ${name || "Hub"}`} disabled={busy} onPress={actions} />
        )
      }
    />
  );
}
