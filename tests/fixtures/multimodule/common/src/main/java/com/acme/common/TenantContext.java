package com.acme.common;

public final class TenantContext {
    private static final ThreadLocal<String> CURRENT = new ThreadLocal<>();
    public static String current() { return CURRENT.get(); }
}
