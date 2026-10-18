package com.acme.orders;

import java.util.List;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Query;

public interface OrderRepository extends JpaRepository<Order, Long> {
    @Query("select o from Order o where o.tenantId = :tenantId and o.status = :status")
    List<Order> findByStatus(String tenantId, String status);
}
