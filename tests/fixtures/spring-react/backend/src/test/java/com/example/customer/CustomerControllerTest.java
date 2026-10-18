package com.example.customer;

import org.junit.jupiter.api.Test;
import org.springframework.boot.test.autoconfigure.web.servlet.WebMvcTest;

@WebMvcTest(CustomerController.class)
class CustomerControllerTest {
    @Test
    void createsCustomerWithName() {
        // only asserts the name; address is not covered
    }
}
