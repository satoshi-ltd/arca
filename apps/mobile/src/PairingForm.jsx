import React from "react";
import { Platform, Text, View } from "react-native";
import { useDesign, Field, CodeInput, Button, Icon } from "./components";

export function PairingForm({
  name,
  setName,
  address,
  setAddress,
  code,
  setCode,
  busy,
  blocked = false,
  pair,
}) {
  const { s } = useDesign();
  const device = Platform.OS === "ios" ? "iPhone" : "phone";
  return (
    <>
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
      />
      <Text style={s.caption}>
        Use HTTPS or Tailscale. For local Wi-Fi, enable HTTP in the hub’s
        Settings and enter its private IPv4 address. Local HTTP traffic is not
        encrypted.
      </Text>
      <View style={s.section}>
        <CodeInput
          label="Pairing code"
          value={code}
          onChangeText={setCode}
          editable={!busy}
        />
        <View style={s.centeredRow}>
          <Icon name="clock" size={16} />
          <Text style={s.caption}>Single use · valid ten minutes</Text>
        </View>
      </View>
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
