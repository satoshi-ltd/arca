import React, { useState } from "react";
import { Platform, Text, View } from "react-native";
import {
  useDesign,
  Logo,
  Card,
  FeatureRow,
  StepIndicator,
  Button,
  FolderRow,
  Icon,
} from "./components";
import { PairingForm } from "./PairingForm";
import { bytes, folderSize } from "./format";
export function Onboarding({
  step,
  name,
  setName,
  address,
  setAddress,
  code,
  setCode,
  catalog,
  free,
  busy,
  start,
  pair,
  download,
  skip,
  retry,
}) {
  const { s } = useDesign();
  const device = Platform.OS === "ios" ? "iPhone" : "phone";
  const [selected, setSelected] = useState([]);
  if (step === "welcome")
    return (
      <>
        <Logo size={58} />
        <Text style={s.text}>Your personal drive, on your own devices.</Text>
        <Text accessibilityRole="header" style={s.displayTitle}>
          Many devices.{"\n"}
          <Text style={s.emphasis}>One space.</Text>
        </Text>
        {[
          [
            "folder-check",
            "Complete local copies",
            `The folders you choose, whole, on this ${device}. Offline is a normal day.`,
          ],
          [
            "history",
            "A way back",
            "Restore earlier versions. Conflicts keep both files.",
          ],
          [
            "server",
            "A hub you control",
            "Your storage, your devices. No cloud account, no telemetry.",
          ],
        ].map(([icon, title, description]) => (
          <FeatureRow key={title} icon={icon} title={title}>
            {description}
          </FeatureRow>
        ))}
        <Card title="You need a hub first">
          <Text style={s.text}>
            Install Arca on a computer or a server and make it the hub. Then
            open Devices → Pair a device there to get a code.
          </Text>
        </Card>
        <View style={s.flex} />
        <Button
          label="Get started"
          primary
          icon="arrow-right"
          busy={busy}
          onPress={start}
        />
      </>
    );
  if (step === "pair")
    return (
      <>
        <PairingForm
          name={name}
          setName={setName}
          address={address}
          setAddress={setAddress}
          code={code}
          setCode={setCode}
          busy={busy}
          pair={pair}
        />
        <StepIndicator step={1} />
      </>
    );
  const folders = catalog?.volumes || [];
  const chosen = folders.filter((folder) => selected.includes(folder.id));
  const size = chosen.reduce((total, folder) => total + (folder.bytes || 0), 0);
  return (
    <>
      <View style={s.section}>
        <View style={s.row}>
          <Icon name="check-circle" size={16} />
          <Text style={[s.heading, s.active]}>
            Paired with {catalog?.name || "your hub"}
          </Text>
        </View>
        <Text accessibilityRole="header" style={s.title}>
          Make room for what matters
        </Text>
        <Text style={s.text}>
          Whole folders, kept on this {device}. Add more any time.
        </Text>
      </View>
      {!catalog ? (
        <Button label="Load folders" onPress={retry} busy={busy} />
      ) : !folders.length ? (
        <Card>
          <Text style={s.text}>
            Your hub has no shared folders yet. Add one on the hub, then choose
            it here.
          </Text>
        </Card>
      ) : null}
      <View style={s.folderList}>
        {folders.map((folder) => (
          <FolderRow
            key={folder.id}
            name={folder.name}
            description={folder.policyError || folderSize(folder)}
            selectable
            selected={selected.includes(folder.id)}
            disabled={
              busy || !!folder.policyError || !Number.isFinite(folder.bytes)
            }
            onPress={() =>
              setSelected((previous) =>
                previous.includes(folder.id)
                  ? previous.filter((id) => id !== folder.id)
                  : [...previous, folder.id],
              )
            }
          />
        ))}
      </View>
      <Text style={[s.caption, s.centerText]}>
        {chosen.length === 1 ? chosen[0].name : `${chosen.length} folders`} ·{" "}
        {bytes(size)} ·{" "}
        {Number.isFinite(free)
          ? `${bytes(free)} free on this ${device}`
          : "Checking available space"}
      </Text>
      <View style={s.flex} />
      <Button
        label={`Download ${chosen.length} ${chosen.length === 1 ? "folder" : "folders"}`}
        icon="download"
        primary
        disabled={!chosen.length}
        busy={busy}
        onPress={() => download(chosen.map((folder) => folder.id))}
      />
      <Button label="Skip for now" quiet busy={busy} onPress={skip} />
      <StepIndicator step={2} />
    </>
  );
}
