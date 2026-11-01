import React, { useState } from "react";
import { Platform, Pressable, View } from "react-native";
import { Text } from "./Text";
import { useDesign, Field, CodeInput, Button } from "./components";

export function PairingForm({
  name,
  setName,
  address,
  setAddress,
  code,
  setCode,
  codeError = "",
  busy,
  blocked = false,
  back,
  pair,
}) {
  const { s } = useDesign();
  const [details, setDetails] = useState(false);
  const device = Platform.OS === "ios" ? "iPhone" : "phone";
  return (
    <>
      {!!back && (
        <Button label="Back" icon="back" ghost disabled={busy} onPress={back} />
      )}
      <Text accessibilityRole="header" style={s.title}>
        Pair with your hub
      </Text>
      <Text style={s.text}>
        On the hub, open Devices → Pair a device. It shows the address and a
        single-use code.
      </Text>
      <Field
        label="Hub address"
        icon="server"
        value={address}
        onChangeText={setAddress}
        placeholder="https://arca.your-network"
        keyboardType="url"
        editable={!busy}
        hint="Use HTTPS or Tailscale."
      />
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Using local Wi-Fi?"
        accessibilityState={{ expanded: details }}
        onPress={() => setDetails((value) => !value)}
      >
        <Text style={[s.caption, s.active]}>Using local Wi-Fi?</Text>
      </Pressable>
      {details && (
        <Text style={s.caption}>
          For local Wi-Fi, enable HTTP in the hub’s Settings and enter its
          private IPv4 address. Local HTTP traffic is not encrypted.
        </Text>
      )}
      <CodeInput
        label="Pairing code"
        value={code}
        onChangeText={setCode}
        editable={!busy}
        hint="Single use · valid ten minutes"
        error={codeError}
      />
      <Field
        label={`Name this ${device}`}
        icon="phone"
        value={name}
        onChangeText={setName}
        maxLength={100}
        editable={!busy}
      />
      <View style={s.flex} />
      <Button
        label={`Pair this ${device}`}
        primary
        icon="key"
        busy={busy}
        disabled={
          blocked || !name.trim() || !address.trim() || code.length !== 6
        }
        onPress={pair}
      />
    </>
  );
}
