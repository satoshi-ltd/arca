import React from "react";
import { Button, MachineRow, useDesign } from "./components";
export function HubConnection({
  connection,
  name,
  machine,
  busy,
  disconnect,
  retry,
}) {
  const { wide } = useDesign();
  const address = new URL(connection.url);
  const platform =
    { linux: "Linux", darwin: "macOS", win32: "Windows" }[machine?.platform] ||
    machine?.platform;
  return (
    <MachineRow
      hub
      role="Hub"
      name={name || "Hub"}
      description={[
        platform,
        address.host,
        connection.leaving ? "Disconnection pending" : "",
      ]
        .filter(Boolean)
        .join(" · ")}
      actions={
        <Button
          danger
          iconOnly={!wide}
          icon="unlink"
          label={connection.leaving ? "Retry disconnect" : "Disconnect…"}
          disabled={busy}
          onPress={connection.leaving ? retry : disconnect}
        />
      }
    />
  );
}
