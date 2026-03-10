package io.agentmc.resident;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.time.Instant;
import java.util.Collection;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import org.bukkit.Location;
import org.bukkit.World;
import org.bukkit.event.entity.EntityDamageEvent;
import org.bukkit.event.player.PlayerBedEnterEvent;
import org.bukkit.entity.Player;

public final class BrainClient {
    private final ResidentPlugin plugin;
    private final HttpClient httpClient;
    private final URI endpoint;
    private final URI presentationEndpoint;
    private final Duration requestTimeout;
    private final String authToken;
    private final String serverName;

    public BrainClient(ResidentPlugin plugin) {
        this.plugin = plugin;

        String endpointValue = plugin.getConfig().getString("brain.endpoint", "https://brain.example.invalid/brain/events");
        this.endpoint = URI.create(endpointValue);
        this.presentationEndpoint = endpoint.resolve("/resident/presentation");

        long connectTimeoutMs = Math.max(100L, plugin.getConfig().getLong("brain.connect-timeout-ms", 2_000L));
        long requestTimeoutMs = Math.max(100L, plugin.getConfig().getLong("brain.request-timeout-ms", 5_000L));

        this.requestTimeout = Duration.ofMillis(requestTimeoutMs);
        this.authToken = plugin.getConfig().getString("brain.auth-token", "").trim();
        this.serverName = plugin.getConfig().getString("brain.server-name", plugin.getServer().getName());
        this.httpClient = HttpClient.newBuilder()
            .connectTimeout(Duration.ofMillis(connectTimeoutMs))
            .build();
    }

    public String endpoint() {
        return endpoint.toString();
    }

    public CompletableFuture<ResidentPresentationSnapshot> fetchResidentPresentation() {
        HttpRequest.Builder requestBuilder = HttpRequest.newBuilder(presentationEndpoint)
            .timeout(requestTimeout)
            .header("Accept", "application/json")
            .GET();

        if (!authToken.isBlank()) {
            requestBuilder.header("Authorization", "Bearer " + authToken);
        }

        return httpClient.sendAsync(requestBuilder.build(), HttpResponse.BodyHandlers.ofString())
            .thenApply(response -> {
                int statusCode = response.statusCode();
                if (statusCode >= 200 && statusCode < 300) {
                    return parseResidentPresentation(response.body());
                }

                plugin.getLogger().warning(
                    "Brain endpoint returned HTTP " + statusCode + " for resident presentation."
                );
                return new ResidentPresentationSnapshot(null);
            })
            .exceptionally(error -> {
                plugin.getLogger().warning("Failed to GET resident presentation: " + error.getMessage());
                return new ResidentPresentationSnapshot(null);
            });
    }

    public CompletableFuture<Boolean> postResidentStatus(Player player, String status, String origin) {
        LinkedHashMap<String, Object> payload = basePayload("resident_status", player);
        payload.put("status", status);
        payload.put("origin", origin);
        return postJson(payload);
    }

    public CompletableFuture<Boolean> postPlayerFeedback(Player player, String message) {
        LinkedHashMap<String, Object> payload = basePayload("player_feedback", player);
        payload.put("message", message);
        return postJson(payload);
    }

    public CompletableFuture<Boolean> postProtectedAreaConflict(Player player, ProtectedArea area, String action) {
        LinkedHashMap<String, Object> payload = basePayload("protected_area_conflict", player);
        payload.put("action", action);
        payload.put("area", area.toPayload());
        return postJson(payload);
    }

    public CompletableFuture<Boolean> postProtectedAreaSnapshot(Collection<ProtectedArea> areas, String reason) {
        LinkedHashMap<String, Object> payload = basePayload("protected_areas_snapshot");
        payload.put("reason", reason);
        payload.put("area_count", areas.size());
        payload.put("areas", areas.stream().map(ProtectedArea::toPayload).toList());
        return postJson(payload);
    }

    public CompletableFuture<Boolean> postResidentDeath(Player player, String deathMessage) {
        LinkedHashMap<String, Object> payload = basePayload("resident_death", player);
        payload.put("death_message", deathMessage == null ? "" : deathMessage);

        EntityDamageEvent damageEvent = player.getLastDamageCause();
        if (damageEvent != null) {
            payload.put("cause", damageEvent.getCause().name().toLowerCase());
        }

        return postJson(payload);
    }

    public CompletableFuture<Boolean> postResidentBedEvent(
        Player player,
        PlayerBedEnterEvent.BedEnterResult result
    ) {
        LinkedHashMap<String, Object> payload = basePayload("resident_bed_event", player);
        payload.put("result", result.name().toLowerCase());
        payload.put("accepted", result == PlayerBedEnterEvent.BedEnterResult.OK);
        return postJson(payload);
    }

    public CompletableFuture<Boolean> postPlayerChat(Player player, String message, boolean nearResident) {
        LinkedHashMap<String, Object> payload = basePayload("player_chat", player);
        payload.put("message", message);
        payload.put("near_resident", nearResident);
        return postJson(payload);
    }

    public CompletableFuture<Boolean> postWorldWeather(World world, boolean toWeatherState) {
        LinkedHashMap<String, Object> payload = basePayload("world_weather");
        payload.put("world", buildWorldPayload(world));
        payload.put("storming", toWeatherState);
        payload.put("thundering", world.isThundering());
        return postJson(payload);
    }

    private LinkedHashMap<String, Object> basePayload(String type) {
        LinkedHashMap<String, Object> payload = new LinkedHashMap<>();
        payload.put("type", type);
        payload.put("timestamp", Instant.now().toString());
        payload.put("server", serverName);
        return payload;
    }

    private LinkedHashMap<String, Object> basePayload(String type, Player player) {
        LinkedHashMap<String, Object> payload = basePayload(type);
        payload.put("player", buildPlayerPayload(player));
        return payload;
    }

    private Map<String, Object> buildPlayerPayload(Player player) {
        Location location = player.getLocation();

        LinkedHashMap<String, Object> coordinates = new LinkedHashMap<>();
        coordinates.put("x", round(location.getX()));
        coordinates.put("y", round(location.getY()));
        coordinates.put("z", round(location.getZ()));
        coordinates.put("yaw", round(location.getYaw()));
        coordinates.put("pitch", round(location.getPitch()));

        LinkedHashMap<String, Object> payload = new LinkedHashMap<>();
        payload.put("uuid", player.getUniqueId().toString());
        payload.put("name", player.getName());
        payload.put("world", player.getWorld().getName());
        payload.put("location", coordinates);
        return payload;
    }

    private Map<String, Object> buildWorldPayload(World world) {
        LinkedHashMap<String, Object> payload = new LinkedHashMap<>();
        payload.put("name", world.getName());
        payload.put("environment", world.getEnvironment().name().toLowerCase());
        payload.put("difficulty", world.getDifficulty().name().toLowerCase());
        payload.put("time", world.getTime());
        payload.put("full_time", world.getFullTime());
        return payload;
    }

    private CompletableFuture<Boolean> postJson(Map<String, Object> payload) {
        String json = JsonUtil.toJson(payload);

        HttpRequest.Builder requestBuilder = HttpRequest.newBuilder(endpoint)
            .timeout(requestTimeout)
            .header("Content-Type", "application/json")
            .POST(HttpRequest.BodyPublishers.ofString(json));

        if (!authToken.isBlank()) {
            requestBuilder.header("Authorization", "Bearer " + authToken);
        }

        return httpClient.sendAsync(requestBuilder.build(), HttpResponse.BodyHandlers.ofString())
            .thenApply(response -> {
                int statusCode = response.statusCode();
                if (statusCode >= 200 && statusCode < 300) {
                    return true;
                }

                plugin.getLogger().warning(
                    "Brain endpoint returned HTTP " + statusCode + " for " + payload.get("type") + "."
                );
                return false;
            })
            .exceptionally(error -> {
                plugin.getLogger().warning("Failed to POST to local brain endpoint: " + error.getMessage());
                return false;
            });
    }

    private static double round(double value) {
        return Math.round(value * 100.0D) / 100.0D;
    }

    private static ResidentPresentationSnapshot parseResidentPresentation(String json) {
        if (json == null || json.isBlank()) {
            return new ResidentPresentationSnapshot(null);
        }

        int thoughtIndex = json.indexOf("\"thought\"");
        if (thoughtIndex < 0) {
            return new ResidentPresentationSnapshot(null);
        }

        int colonIndex = json.indexOf(':', thoughtIndex);
        if (colonIndex < 0) {
            return new ResidentPresentationSnapshot(null);
        }

        String thoughtJson = json.substring(colonIndex + 1).trim();
        if (thoughtJson.startsWith("null")) {
            return new ResidentPresentationSnapshot(null);
        }

        return new ResidentPresentationSnapshot(
            new ResidentPresentationThought(
                extractJsonString(thoughtJson, "residentId"),
                extractJsonString(thoughtJson, "residentName"),
                extractJsonString(thoughtJson, "text"),
                extractJsonString(thoughtJson, "createdAt"),
                extractJsonString(thoughtJson, "expiresAt")
            )
        );
    }

    private static String extractJsonString(String json, String field) {
        Pattern pattern = Pattern.compile("\"" + Pattern.quote(field) + "\"\\s*:\\s*\"((?:\\\\.|[^\"\\\\])*)\"");
        Matcher matcher = pattern.matcher(json);
        if (!matcher.find()) {
            return "";
        }

        return unescapeJson(matcher.group(1));
    }

    private static String unescapeJson(String value) {
        StringBuilder builder = new StringBuilder(value.length());

        for (int index = 0; index < value.length(); index++) {
            char current = value.charAt(index);
            if (current != '\\' || index + 1 >= value.length()) {
                builder.append(current);
                continue;
            }

            char escaped = value.charAt(++index);
            switch (escaped) {
                case '"' -> builder.append('"');
                case '\\' -> builder.append('\\');
                case '/' -> builder.append('/');
                case 'b' -> builder.append('\b');
                case 'f' -> builder.append('\f');
                case 'n' -> builder.append('\n');
                case 'r' -> builder.append('\r');
                case 't' -> builder.append('\t');
                case 'u' -> {
                    if (index + 4 >= value.length()) {
                        builder.append("\\u");
                        break;
                    }

                    String hex = value.substring(index + 1, index + 5);
                    builder.append((char) Integer.parseInt(hex, 16));
                    index += 4;
                }
                default -> builder.append(escaped);
            }
        }

        return builder.toString();
    }

    public record ResidentPresentationThought(
        String residentId,
        String residentName,
        String text,
        String createdAt,
        String expiresAt
    ) {
    }

    public record ResidentPresentationSnapshot(ResidentPresentationThought thought) {
    }
}
