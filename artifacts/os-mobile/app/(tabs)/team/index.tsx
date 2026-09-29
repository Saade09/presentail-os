import {
  useListPeople,
  getListPeopleQueryKey,
} from "@workspace/api-client-react";
import { Feather } from "@expo/vector-icons";
import { Image } from "expo-image";
import React from "react";
import {
  ActivityIndicator,
  FlatList,
  RefreshControl,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useQueryClient } from "@tanstack/react-query";

import { useColors } from "@/hooks/useColors";

type PersonRow = {
  id: string;
  source: string;
  first_name: string | null;
  last_name: string | null;
  email: string | null;
  phone: string | null;
  job_title: string | null;
  department_name: string | null;
  image_url: string | null;
  access_type: string;
  employment_status: string | null;
  archived_at: string | null;
};

function getInitials(firstName: string | null, lastName: string | null): string {
  const f = firstName?.charAt(0) ?? "";
  const l = lastName?.charAt(0) ?? "";
  return (f + l).toUpperCase() || "?";
}

function MemberAvatar({
  imageUrl,
  firstName,
  lastName,
  colors,
}: {
  imageUrl: string | null | undefined;
  firstName: string | null;
  lastName: string | null;
  colors: ReturnType<typeof useColors>;
}) {
  const initials = getInitials(firstName, lastName);

  if (imageUrl) {
    return (
      <Image
        source={{ uri: imageUrl }}
        style={[avatarStyles.avatar, { backgroundColor: colors.muted }]}
        contentFit="cover"
        cachePolicy="memory-disk"
        testID="member-avatar-image"
      />
    );
  }

  return (
    <View
      testID="member-avatar-initials"
      style={[avatarStyles.avatar, avatarStyles.initialsContainer, { backgroundColor: colors.secondary }]}
    >
      <Text style={[avatarStyles.initials, { color: colors.secondaryForeground, fontFamily: "Inter_600SemiBold" }]}>
        {initials}
      </Text>
    </View>
  );
}

const avatarStyles = StyleSheet.create({
  avatar: {
    width: 44,
    height: 44,
    borderRadius: 22,
  },
  initialsContainer: {
    alignItems: "center",
    justifyContent: "center",
  },
  initials: {
    fontSize: 16,
  },
});

function accessTypeBadge(
  accessType: string,
  colors: ReturnType<typeof useColors>,
): { label: string; bg: string; fg: string } {
  switch (accessType) {
    case "owner":
      return { label: "Owner", bg: colors.primary + "22", fg: colors.primary };
    case "user":
      return { label: "Member", bg: colors.success + "22", fg: colors.success };
    case "pending_invite":
      return { label: "Invited", bg: colors.warning + "22", fg: colors.warning };
    case "team_member_only":
      return { label: "No login", bg: colors.muted, fg: colors.mutedForeground };
    default:
      return { label: accessType, bg: colors.muted, fg: colors.mutedForeground };
  }
}

function MemberCard({
  person,
  colors,
}: {
  person: PersonRow;
  colors: ReturnType<typeof useColors>;
}) {
  const displayName =
    [person.first_name, person.last_name].filter(Boolean).join(" ") || person.email || "Unknown";

  const badge = accessTypeBadge(person.access_type, colors);

  return (
    <View testID="member-card" style={[cardStyles.card, { backgroundColor: colors.card, borderColor: colors.border }]}>
      <View style={cardStyles.row}>
        <MemberAvatar
          imageUrl={person.image_url}
          firstName={person.first_name}
          lastName={person.last_name}
          colors={colors}
        />
        <View style={cardStyles.info}>
          <View style={cardStyles.nameRow}>
            <Text style={[cardStyles.name, { color: colors.foreground, fontFamily: "Inter_600SemiBold" }]}>
              {displayName}
            </Text>
            <View style={[cardStyles.badge, { backgroundColor: badge.bg }]}>
              <Text style={[cardStyles.badgeText, { color: badge.fg, fontFamily: "Inter_500Medium" }]}>
                {badge.label}
              </Text>
            </View>
          </View>

          {person.job_title ? (
            <Text style={[cardStyles.meta, { color: colors.mutedForeground, fontFamily: "Inter_400Regular" }]}>
              {person.job_title}
              {person.department_name ? ` · ${person.department_name}` : ""}
            </Text>
          ) : person.department_name ? (
            <Text style={[cardStyles.meta, { color: colors.mutedForeground, fontFamily: "Inter_400Regular" }]}>
              {person.department_name}
            </Text>
          ) : null}

          {person.email ? (
            <Text style={[cardStyles.email, { color: colors.mutedForeground, fontFamily: "Inter_400Regular" }]} numberOfLines={1}>
              {person.email}
            </Text>
          ) : null}
        </View>
      </View>
    </View>
  );
}

const cardStyles = StyleSheet.create({
  card: {
    borderRadius: 14,
    borderWidth: 1,
    padding: 14,
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
  },
  info: {
    flex: 1,
    gap: 3,
  },
  nameRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    flexWrap: "wrap",
  },
  name: {
    fontSize: 15,
  },
  badge: {
    borderRadius: 6,
    paddingHorizontal: 7,
    paddingVertical: 2,
  },
  badgeText: {
    fontSize: 11,
  },
  meta: {
    fontSize: 13,
    lineHeight: 18,
  },
  email: {
    fontSize: 12,
    lineHeight: 16,
  },
});

export default function TeamScreen() {
  const colors = useColors();
  const queryClient = useQueryClient();

  const { data, isLoading, isFetching, refetch } = useListPeople();

  const result = data as { people?: PersonRow[] } | undefined;
  const people = (result?.people ?? []).filter((p) => !p.archived_at);

  function onRefresh() {
    void queryClient.invalidateQueries({ queryKey: getListPeopleQueryKey() });
    void refetch();
  }

  if (isLoading) {
    return (
      <SafeAreaView style={[styles.safe, { backgroundColor: colors.background }]} edges={["bottom"]}>
        <View style={styles.center}>
          <ActivityIndicator color={colors.primary} size="large" />
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={[styles.safe, { backgroundColor: colors.background }]} edges={["bottom"]}>
      {people.length === 0 ? (
        <View style={styles.center}>
          <Feather name="users" size={40} color={colors.mutedForeground} style={{ marginBottom: 16 }} />
          <Text style={[styles.emptyText, { color: colors.mutedForeground, fontFamily: "Inter_500Medium" }]}>
            No team members yet
          </Text>
          <Text style={[styles.emptySubtext, { color: colors.mutedForeground, fontFamily: "Inter_400Regular" }]}>
            Team members will appear here once they are added.
          </Text>
        </View>
      ) : (
        <FlatList
          data={people}
          keyExtractor={(item) => item.id}
          contentContainerStyle={styles.list}
          refreshControl={
            <RefreshControl
              refreshing={isFetching && !isLoading}
              onRefresh={onRefresh}
              tintColor={colors.primary}
            />
          }
          ListHeaderComponent={
            <Text testID="team-count-label" style={[styles.countLabel, { color: colors.mutedForeground, fontFamily: "Inter_500Medium" }]}>
              {people.length} {people.length === 1 ? "person" : "people"}
            </Text>
          }
          renderItem={({ item }) => (
            <MemberCard person={item} colors={colors} />
          )}
        />
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1 },
  center: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: 32,
    gap: 8,
  },
  emptyText: { fontSize: 16, textAlign: "center" },
  emptySubtext: { fontSize: 13, textAlign: "center", lineHeight: 20 },
  list: { padding: 16, gap: 12 },
  countLabel: {
    fontSize: 13,
    marginBottom: 4,
  },
});
