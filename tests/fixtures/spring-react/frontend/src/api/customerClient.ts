export interface CustomerFormValues {
  name: string;
  email: string;
  address: string;
}

export async function createCustomer(values: CustomerFormValues): Promise<Response> {
  return fetch("/api/customers", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: values.name,
      email: values.email,
      address: values.address,
    }),
  });
}
