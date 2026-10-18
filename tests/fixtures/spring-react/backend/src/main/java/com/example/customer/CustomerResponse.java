package com.example.customer;

public record CustomerResponse(Long id, String name, String streetAddress) {
    static CustomerResponse from(Customer c) {
        return new CustomerResponse(c.getId(), c.getName(), c.getStreetAddress());
    }
}
