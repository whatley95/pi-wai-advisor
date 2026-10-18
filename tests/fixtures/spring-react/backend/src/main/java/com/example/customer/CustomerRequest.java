package com.example.customer;

/** Request body bound by Jackson from the client JSON. */
public record CustomerRequest(
        String name,
        String email,
        String streetAddress
) {
}
