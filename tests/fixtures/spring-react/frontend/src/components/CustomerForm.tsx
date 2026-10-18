import { useState } from "react";
import { createCustomer } from "../api/customerClient";

export function CustomerForm() {
  const [values, setValues] = useState({ name: "", email: "", address: "" });
  async function onSubmit() {
    const response = await createCustomer(values);
    if (response.ok) alert("Saved");
  }
  return <form onSubmit={onSubmit}>{/* inputs bound to values */}</form>;
}
