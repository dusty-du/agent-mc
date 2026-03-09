package io.agentmc.resident;

import java.util.Map;

public final class JsonUtil {
    private JsonUtil() {
    }

    public static String toJson(Object value) {
        StringBuilder builder = new StringBuilder();
        appendJson(builder, value);
        return builder.toString();
    }

    private static void appendJson(StringBuilder builder, Object value) {
        if (value == null) {
            builder.append("null");
            return;
        }

        if (value instanceof String stringValue) {
            appendQuoted(builder, stringValue);
            return;
        }

        if (value instanceof Number || value instanceof Boolean) {
            builder.append(value);
            return;
        }

        if (value instanceof Map<?, ?> mapValue) {
            builder.append('{');
            boolean first = true;
            for (Map.Entry<?, ?> entry : mapValue.entrySet()) {
                if (!first) {
                    builder.append(',');
                }

                appendQuoted(builder, String.valueOf(entry.getKey()));
                builder.append(':');
                appendJson(builder, entry.getValue());
                first = false;
            }
            builder.append('}');
            return;
        }

        if (value instanceof Iterable<?> iterable) {
            builder.append('[');
            boolean first = true;
            for (Object entry : iterable) {
                if (!first) {
                    builder.append(',');
                }

                appendJson(builder, entry);
                first = false;
            }
            builder.append(']');
            return;
        }

        appendQuoted(builder, String.valueOf(value));
    }

    private static void appendQuoted(StringBuilder builder, String value) {
        builder.append('"');
        for (int index = 0; index < value.length(); index++) {
            char current = value.charAt(index);
            switch (current) {
                case '\\' -> builder.append("\\\\");
                case '"' -> builder.append("\\\"");
                case '\b' -> builder.append("\\b");
                case '\f' -> builder.append("\\f");
                case '\n' -> builder.append("\\n");
                case '\r' -> builder.append("\\r");
                case '\t' -> builder.append("\\t");
                default -> {
                    if (current < 0x20) {
                        builder.append(String.format("\\u%04x", (int) current));
                    } else {
                        builder.append(current);
                    }
                }
            }
        }
        builder.append('"');
    }
}
