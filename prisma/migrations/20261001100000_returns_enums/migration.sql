-- New enum values get their own migration: PostgreSQL cannot use a value in the transaction that adds it.
ALTER TYPE "MovementType" ADD VALUE 'RETURN';
