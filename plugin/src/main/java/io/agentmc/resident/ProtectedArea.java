package io.agentmc.resident;

import java.util.LinkedHashMap;
import java.util.Map;
import org.bukkit.Location;
import org.bukkit.configuration.ConfigurationSection;

public record ProtectedArea(
    String id,
    String label,
    String world,
    double x,
    double y,
    double z,
    double radius,
    String owner
) {
    public boolean contains(Location location) {
        if (location == null || !location.getWorld().getName().equals(world)) {
            return false;
        }

        double dx = location.getX() - x;
        double dy = location.getY() - y;
        double dz = location.getZ() - z;
        return (dx * dx) + (dy * dy) + (dz * dz) <= radius * radius;
    }

    public Map<String, Object> toPayload() {
        LinkedHashMap<String, Object> payload = new LinkedHashMap<>();
        payload.put("id", id);
        payload.put("label", label);
        payload.put("owner", owner);
        payload.put("world", world);

        LinkedHashMap<String, Object> center = new LinkedHashMap<>();
        center.put("x", round(x));
        center.put("y", round(y));
        center.put("z", round(z));
        payload.put("center", center);
        payload.put("radius", round(radius));
        return payload;
    }

    public static ProtectedArea fromConfig(String id, ConfigurationSection section) {
        return new ProtectedArea(
            id,
            section.getString("label", id),
            section.getString("world", "world"),
            section.getDouble("x"),
            section.getDouble("y"),
            section.getDouble("z"),
            Math.max(1.0D, section.getDouble("radius", 8.0D)),
            section.getString("owner", "server")
        );
    }

    public void writeTo(ConfigurationSection section) {
        section.set("label", label);
        section.set("world", world);
        section.set("x", x);
        section.set("y", y);
        section.set("z", z);
        section.set("radius", radius);
        section.set("owner", owner);
    }

    private static double round(double value) {
        return Math.round(value * 100.0D) / 100.0D;
    }
}
